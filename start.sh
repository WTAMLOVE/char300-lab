#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$project_dir"

if [[ ${EUID} -eq 0 ]]; then
  printf '请以普通用户运行 ./start.sh；仅首次配置 Caddy 时会提示输入 sudo 密码。\n' >&2
  exit 1
fi

if [[ $project_dir != "$HOME/workspace/github/char300-lab" ]]; then
  printf 'deploy/char300.service 的工作目录固定为 %s；移动项目后请先同步修改该服务文件。\n' "$HOME/workspace/github/char300-lab" >&2
  exit 1
fi

for command_name in fnm systemctl curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '缺少 %s，请先安装。\n' "$command_name" >&2
    exit 1
  fi
done

if [[ ! -f .env ]]; then
  install -m 0600 .env.example .env
  printf '已创建 .env；AI 配置可稍后填写。\n'
fi

fnm exec --using=v22 node --env-file=.env -e '
  if (process.env.HOST !== "127.0.0.1" || process.env.PORT !== "8787" || process.env.APP_ORIGIN !== "https://char300.com") {
    console.error("请在 .env 中设置 HOST=127.0.0.1、PORT=8787、APP_ORIGIN=https://char300.com。");
    process.exit(1);
  }
'

printf '安装依赖并构建站点…\n'
fnm exec --using=v22 pnpm install --frozen-lockfile
fnm exec --using=v22 pnpm run build

service_file="$project_dir/deploy/char300.service"
current_unit=$(systemctl --user show -p FragmentPath --value char300.service)
if [[ -n "$current_unit" ]]; then
  if [[ $(realpath "$current_unit") != "$service_file" ]]; then
    printf 'char300.service 已指向其他文件：%s\n' "$current_unit" >&2
    exit 1
  fi
else
  systemctl --user link "$service_file"
fi
systemctl --user daemon-reload
systemctl --user enable char300.service
systemctl --user restart char300.service

backend_ready=false
for ((attempt = 0; attempt < 20; attempt++)); do
  if curl --noproxy '*' --fail --silent --output /dev/null http://127.0.0.1:8787/; then
    backend_ready=true
    break
  fi
  sleep 1
done
if [[ $backend_ready != true ]]; then
  printf '项目服务未能启动，请检查：journalctl --user -u char300.service -n 50\n' >&2
  exit 1
fi

if ! command -v caddy >/dev/null 2>&1 || ! cmp -s Caddyfile /etc/caddy/Caddyfile; then
  if [[ ! -f /etc/fedora-release ]]; then
    printf '请按 docs/LAN_HTTPS.md 安装 Caddy 并加载项目 Caddyfile。\n' >&2
    exit 1
  fi
  printf '安装或更新 Caddy 配置需要 sudo 权限。\n'
  sudo bash "$project_dir/scripts/setup-caddy-fedora.sh"
elif ! systemctl is-active --quiet caddy || ! systemctl is-enabled --quiet caddy; then
  printf '启动 Caddy 需要 sudo 权限。\n'
  sudo systemctl enable --now caddy
fi

http_status=$(curl --noproxy '*' --silent --show-error --insecure \
  --resolve char300.com:443:127.0.0.1 --output /dev/null \
  --write-out '%{http_code}' https://char300.com/)
if [[ $http_status != 200 ]]; then
  printf 'Caddy 已启动，但首页返回 HTTP %s；请检查服务日志。\n' "$http_status" >&2
  exit 1
fi

printf '项目已启动：https://char300.com/\n'
printf '本机已验证 HTTPS 路由；其他设备仍需局域网 DNS 和 Caddy 根证书信任。\n'
