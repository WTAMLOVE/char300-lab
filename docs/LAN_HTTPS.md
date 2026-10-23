# 局域网 HTTPS 部署：char300.com

本部署为**整个逐字站点**提供 `https://char300.com`，包括首页、JS/CSS、图标、Web App Manifest、Service Worker 和 `/api/translate`。`Caddyfile` 中的 `tls internal` 指定由 Caddy 本地 CA 为 `char300.com` 签发证书；证书按域名生效，不按功能或路径划分。Caddy 将所有请求代理到本机 `127.0.0.1:8787`，由现有 Node 服务分别处理页面和接口。

## 前提

- 在局域网主机上安装 Caddy，并保证它和 Node 服务运行在同一台主机。安装方法见 [Caddy 官方文档](https://caddyserver.com/docs/install)。
- 给这台主机固定局域网 IP，在访问设备使用的局域网 DNS 或 hosts 中把 `char300.com` 指向该 IP。所有设备都必须解析到局域网主机；修改公网上的 DNS 并非必要。`char300.com` 是普通域名，单独写进 Caddyfile 不会让其他设备自动找到服务器。
- 仅允许受信任局域网的设备访问 Caddy 的 80/443 端口；路由器不要做公网端口映射。Node 端口 8787 仅监听本机环回地址。

## 启动

1. 复制 `.env.example` 为 `.env`，配置 AI 服务，并设置：

   ```dotenv
   HOST=127.0.0.1
   PORT=8787
   APP_ORIGIN=https://char300.com
   ```

   `.env` 包含 AI 密钥，只保留在服务器本地，不提交到仓库。

2. 在项目目录安装依赖、构建并启动 Node 服务：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   pnpm run start
   ```

   让 Node 进程长期运行。它提供整个构建后的站点，Caddy 只负责 HTTPS 入口与反向代理。修改页面后需重新构建，修改服务端配置后需重启 Node 服务。

3. 在另一终端检查并加载项目根目录的 `Caddyfile`。若使用系统 Caddy 服务，可将文件安装到 `/etc/caddy/Caddyfile` 后验证并重载：

   ```bash
   sudo cp Caddyfile /etc/caddy/Caddyfile
   caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

   首次安装服务且尚未运行时，使用 `sudo systemctl enable --now caddy` 启动。保留 Caddy 的数据目录；本地 CA 的私钥和自动签发的证书保存在那里。不要把 CA 私钥复制给客户端。

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
