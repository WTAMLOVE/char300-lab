# 局域网 HTTPS 部署：char300.com

本部署为**整个逐字站点**提供 `https://char300.com`，包括首页、JS/CSS、图标、Web App Manifest、Service Worker 和 `/api/translate`。`Caddyfile` 中的 `tls internal` 指定由 Caddy 本地 CA 为 `char300.com` 签发证书；证书按域名生效，不按功能或路径划分。Caddy 将所有请求代理到本机 `127.0.0.1:8787`，由现有 Node 服务分别处理页面和接口。

## 前提

- 在局域网主机上安装 Caddy，并保证它和 Node 服务运行在同一台主机。安装方法见 [Caddy 官方文档](https://caddyserver.com/docs/install)。
- 给这台主机固定局域网 IP，在访问设备使用的局域网 DNS 或 hosts 中把 `char300.com` 指向该 IP。所有设备都必须解析到局域网主机；修改公网上的 DNS 并非必要。`char300.com` 是普通域名，单独写进 Caddyfile 不会让其他设备自动找到服务器。
- 仅允许受信任局域网的设备访问 Caddy 的 80/443 端口；路由器不要做公网端口映射。Node 端口 8787 仅监听本机环回地址。

## 启动

在当前 Fedora 主机上，可从项目根目录执行 `./start.sh` 一键完成下面的依赖安装、构建、项目服务启动与 Caddy 检查。脚本不会覆盖已有 `.env`；首次需要安装或更新 Caddy、或者本机尚未信任其根证书时会请求 sudo 权限。脚本会分别报告端口监听、局域网 IP、HTTP 响应、防火墙、本机域名解析和系统证书信任。路由检查特意绕过 DNS 和根证书信任；最后的普通 HTTPS 请求会检查本机证书信任，必要时执行 `sudo caddy trust`，其他访问设备仍需单独验收。`netstat` 将 Caddy 的 80/443 显示为 `tcp6 :::80/:::443` 时，若 IPv4 局域网 IP 的 HTTP 检查返回 200，说明该双栈监听也接受 IPv4。下面保留手动步骤，便于排查。

1. 复制 `.env.example` 为 `.env`，保留站点访问地址与监听设置：

   ```dotenv
   HOST=127.0.0.1
   PORT=8787
   APP_ORIGIN=https://char300.com
   ```

   AI 配置可以暂时留空，站点仍会启动；点击翻译时会提示先配置 AI 接口。需要翻译时，在 `.env` 中填写所选服务的 API 地址前缀、接口格式、模型与密钥，然后重启 Node 服务。`.env` 只保留在服务器本地，不提交到仓库。

2. 在项目目录安装依赖、构建并启动 Node 服务：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   pnpm run start
   ```

   让 Node 进程长期运行。当前 Fedora 主机可使用仓库中的 `deploy/char300.service` 作为用户级 systemd 服务：

   ```bash
   systemctl --user link "$PWD/deploy/char300.service"
   systemctl --user enable --now char300.service
   ```

   该服务通过 fnm 选用已安装的 Node.js 22；服务文件的工作目录对应本仓库当前的 `/home/sun/workspace/github/char300-lab`，若移动项目需同步修改。Caddy 只负责 HTTPS 入口与反向代理。修改页面后需重新构建，修改 `.env` 后需运行 `systemctl --user restart char300.service`。未配置 AI 变量时，站点正常提供写作功能，翻译请求返回配置提示。

3. 在另一终端安装并启动 Caddy。Fedora 可在项目根目录运行以下脚本；它会通过 `dnf` 安装 Caddy、备份已有的系统 Caddyfile、安装本项目配置、启动系统服务，并输出本地 CA 根证书指纹与 HTTPS 校验结果。运行时需要本机 sudo 权限：

   ```bash
   sudo bash scripts/setup-caddy-fedora.sh
   ```

   其他 Linux 系统可手动安装 Caddy，再检查并加载项目根目录的 `Caddyfile`：

   ```bash
   sudo cp Caddyfile /etc/caddy/Caddyfile
   caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

   首次安装服务且尚未运行时，使用 `sudo systemctl enable --now caddy` 启动。保留 Caddy 的数据目录；本地 CA 的私钥和自动签发的证书保存在那里。不要把 CA 私钥复制给客户端。若 Fedora 防火墙拦截局域网访问，需按实际网络区域放行 80/443，仅限受信任的局域网。

## 信任本地 CA

Caddy 的本地 CA 不会被其他设备默认信任。系统服务部署时，根证书通常在 `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`。在每台访问设备的系统信任库中安装**根证书**；使用独立证书库的浏览器也需要单独导入。服务器自身可按 [Caddy 的本地 HTTPS 说明](https://caddyserver.com/docs/running#local-https-with-systemd) 执行 `sudo caddy trust`。请核对证书确实来自自己的 Caddy 实例，不要分发 CA 私钥。若以其他用户或容器运行 Caddy，根证书路径会不同。

## 检查与迁移

在已配置 DNS 和根证书信任的设备上打开 `https://char300.com`，确认没有证书警告，并检查页面、图标和翻译按钮可用。在浏览器开发者工具中执行：

```js
window.isSecureContext
await navigator.storage.getDirectory()
await navigator.serviceWorker.ready
```

第一项应为 `true`，第二项应返回 OPFS 根目录，第三项应得到 Service Worker 注册。Service Worker 需要首次加载与安装；离线能力可在刷新后再验证。浏览器自身的能力限制仍需按设备检查。

从旧地址迁移时，先在旧站点执行“导出 → 完整数据 ZIP”并妥善保管，再到 `https://char300.com` 执行“导出 → 从 ZIP/JSON 导入”。浏览器存储按 origin 隔离，更换协议、域名或端口不会自动迁移旧档案。

本地 CA 的证书只在已信任该 CA 的设备上有效。未安装或未信任根证书时，浏览器会显示证书警告，OPFS 与 Service Worker 也可能因页面不被视为可信安全上下文而不可用。
