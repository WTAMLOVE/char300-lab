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

for command_name in fnm systemctl curl ss ip getent; do
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

if ! systemctl --user is-active --quiet char300.service || ! systemctl is-active --quiet caddy; then
  printf '项目服务或 Caddy 未运行；请检查 systemctl 状态。\n' >&2
  exit 1
fi

for listen_port in 80 443; do
  if [[ -z $(ss -H -ltn "( sport = :$listen_port )") ]]; then
    printf 'Caddy 服务处于运行状态，但没有监听 %s 端口。\n' "$listen_port" >&2
    exit 1
  fi
done

lan_interface=$(ip -4 -o addr show scope global | awk '$2 != "docker0" { print $2; exit }')
lan_ip=$(ip -4 -o addr show scope global | awk '$2 != "docker0" { sub(/\/.*/, "", $4); print $4; exit }')
if [[ -z $lan_ip ]]; then
  printf '未找到局域网 IPv4 地址；请检查网络接口。\n' >&2
  exit 1
fi

http_status=$(curl --noproxy '*' --silent --show-error --insecure \
  --resolve char300.com:443:127.0.0.1 --output /dev/null \
  --write-out '%{http_code}' https://char300.com/)
if [[ $http_status != 200 ]]; then
  printf 'Caddy 回环入口的首页返回 HTTP %s；请检查服务日志。\n' "$http_status" >&2
  exit 1
fi

http_status=$(curl --noproxy '*' --silent --show-error --insecure \
  --resolve "char300.com:443:$lan_ip" --output /dev/null \
  --write-out '%{http_code}' https://char300.com/)
if [[ $http_status != 200 ]]; then
  printf 'Caddy 在局域网地址 %s 上的首页返回 HTTP %s。\n' "$lan_ip" "$http_status" >&2
  exit 1
fi

printf '项目服务与 Caddy 均已运行；80/443 端口正在监听。\n'
printf '本机经局域网地址 %s 访问 HTTPS 首页：HTTP 200。\n' "$lan_ip"
printf '若 netstat 把 80/443 显示为 tcp6 :::80/:::443，这是双栈监听；上面的 IPv4 请求已验证可用。\n'
printf '上述 HTTP 检查绕过了 DNS 和证书信任，仅验证服务与路由。\n'
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall_zone=$(firewall-cmd --get-zone-of-interface="$lan_interface" 2>/dev/null || true)
  if [[ -n $firewall_zone ]]; then
    if firewall-cmd --zone="$firewall_zone" --query-service=http >/dev/null &&
      firewall-cmd --zone="$firewall_zone" --query-service=https >/dev/null; then
      printf '防火墙区域 %s 已放行 HTTP/HTTPS。\n' "$firewall_zone"
    else
      printf '防火墙区域 %s 尚未同时放行 HTTP/HTTPS，其他设备可能无法访问。\n' "$firewall_zone"
    fi
  fi
fi
if getent ahostsv4 char300.com | awk -v address="$lan_ip" '$1 == address { found = 1 } END { exit !found }'; then
  printf '当前机器已将 char300.com 解析到局域网地址。\n'
  if curl --noproxy '*' --fail --silent --output /dev/null https://char300.com/; then
    printf '当前机器的系统证书库已信任 Caddy 本地 CA。\n'
  else
    printf '当前机器尚未信任 Caddy 本地 CA；尝试使用 sudo caddy trust 安装根证书。\n'
    sudo caddy trust
    if curl --noproxy '*' --fail --silent --output /dev/null https://char300.com/; then
      printf '当前机器现已信任 Caddy 本地 CA。\n'
    else
      printf '根证书安装后仍无法通过本机 HTTPS 校验，请检查系统或浏览器的证书信任设置。\n' >&2
      exit 1
    fi
  fi
else
  printf '当前机器尚未将 char300.com 解析到 %s；请配置局域网 DNS 或 hosts。\n' "$lan_ip"
fi
printf '其他设备还需信任 Caddy 根证书；完成后访问 https://char300.com/。\n'
