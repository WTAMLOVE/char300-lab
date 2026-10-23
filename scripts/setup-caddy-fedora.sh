#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf '请使用 sudo bash scripts/setup-caddy-fedora.sh 运行。\n' >&2
  exit 1
fi

if [[ ! -f /etc/fedora-release ]]; then
  printf '此脚本仅适用于 Fedora；其他系统请按 docs/LAN_HTTPS.md 手动安装。\n' >&2
  exit 1
fi

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root_cert=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

dnf install -y caddy
if [[ -f /etc/caddy/Caddyfile ]] && ! cmp -s "$project_dir/Caddyfile" /etc/caddy/Caddyfile; then
  cp -p /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
fi
install -m 0644 "$project_dir/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

for ((attempt = 0; attempt < 15; attempt++)); do
  if [[ -s "$root_cert" ]]; then
    break
  fi
  sleep 1
done

if [[ ! -s "$root_cert" ]]; then
  printf 'Caddy 已启动，但尚未找到本地 CA 根证书。请检查 journalctl -u caddy。\n' >&2
  exit 1
fi

printf '\nCaddy 服务状态：'
systemctl is-active caddy
printf '本地 CA 根证书：%s\n' "$root_cert"
openssl x509 -in "$root_cert" -noout -subject -fingerprint -sha256

printf '\n验证 char300.com 的 TLS 连接（后端未启动时 HTTP 状态可能是 502）：\n'
curl --noproxy '*' --silent --show-error --resolve char300.com:443:127.0.0.1 \
  --cacert "$root_cert" --output /dev/null \
  --write-out 'HTTP %{http_code}; TLS verification %{ssl_verify_result}\n' \
  https://char300.com/

printf '\n其他设备还需把 char300.com 解析到服务器局域网 IP，并信任上述根证书。\n'
