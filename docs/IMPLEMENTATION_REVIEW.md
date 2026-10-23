# 翻译功能与局域网 HTTPS 实施复查

> 2026-10-24。范围：从 `6f23af0` 之后的翻译功能、pnpm/测试、Caddy HTTPS、无 AI 配置启动和本次代码复查。需求与接口细节分别见 [`TRANSLATION_PLAN.md`](./TRANSLATION_PLAN.md)、[`TRANSLATION_DESIGN.md`](./TRANSLATION_DESIGN.md)；实际部署步骤见 [`LAN_HTTPS.md`](./LAN_HTTPS.md)。

## 已完成的修改

| 部分 | 实施内容 | 主要文件 |
| --- | --- | --- |
| 翻译交互 | 草稿和选中历史版本均可点击“翻译成英文”；显示原文快照与参考译文，支持取消、重试、复制。编辑、切换内容或导入时使旧结果失效。译文不进入文章、版本或备份。 | `src/main.ts`、`src/translation.ts`、`src/styles.css` |
| AI 接口 | `POST /api/translate` 只接收正文；服务端固定自然、日常英文的提示词，支持 Chat Completions 与 Responses 两种接口格式。服务端校验输入、来源与主机、长度、并发和频率，并设置超时；日志不记录正文或密钥。 | `server/prompt.mjs`、`server/providers.mjs`、`server/translate.mjs`、`server/index.mjs` |
| 可选 AI 配置 | `.env.example` 不预设服务商。填写 `AI_API_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 和可选的 `AI_API_FORMAT` 后启用翻译。无配置或配置不完整时，站点仍正常启动；用户点击翻译后收到 503 和配置提示。 | `.env.example`、`server/providers.mjs`、`server/index.mjs` |
| HTTPS 部署 | Caddy 本地 CA 为**整个 `char300.com` 站点**签发证书；页面、资源、Service Worker 和翻译接口共用同一 HTTPS origin。Caddy 代理到仅监听 `127.0.0.1:8787` 的项目服务。提供 Fedora 安装与证书验证脚本，以及用户级 systemd 服务配置。 | `Caddyfile`、`scripts/setup-caddy-fedora.sh`、`deploy/char300.service` |
| 一键启动 | `./start.sh` 自动准备缺失的本地 `.env`、安装锁定依赖、构建页面、启用并重启项目用户服务，按需安装或启动 Caddy，再检查首页。已有 `.env` 不会被覆盖。 | `start.sh`、`README.md`、`docs/LAN_HTTPS.md` |
| 工程与说明 | 依赖改由 pnpm 管理，CI 运行版本检查、测试、类型/构建检查和依赖审计；README、变更记录、方案与设计文档同步更新。 | `package.json`、`pnpm-lock.yaml`、`.github/workflows/quality.yml`、`README.md`、`CHANGELOG.md`、`docs/` |

## 本次复查发现与处理

1. **AI 认证失败的提示不准确。** 原实现把上游 401/403 与“没有配置 AI”归为同一错误，可能误导已配置密钥的用户。现单独返回 `UPSTREAM_AUTH_ERROR`，提示检查服务商地址和密钥；增加了 401/403 单元测试。
2. **证书验证脚本会受到代理环境变量影响。** 本机曾出现 Caddy 已正常工作、`curl` 却经代理报 TLS 错误的情况。脚本现在以 `--noproxy '*'` 强制验证本机 Caddy。
3. **静态文件读取缺少错误处理。** 构建目录中的文件若在打开时被替换，`createReadStream` 可能发出未处理的错误并结束 Node 进程。现在会关闭该请求连接，进程保持运行。

未发现会阻止现有写作流程的其他明显错误。此结论限于代码检查、自动化测试和本机 HTTP 联调；实际 AI 服务的兼容性与翻译质量仍需用选定服务验证。

## 验证结果

- `pnpm run check` 通过：版本一致、11 个测试文件通过、TypeScript 检查通过、Vite 生产构建完成。测试覆盖翻译状态失效、两种上游格式、请求边界与错误映射、无 AI 配置时的接口提示和认证失败提示。站点启动行为另通过本机联调验证。
- `caddy validate --config Caddyfile`、`systemd-analyze --user verify deploy/char300.service`、`bash -n scripts/setup-caddy-fedora.sh`、`git diff --check` 均通过。
- Fedora 主机上的 Caddy 与 `char300.service` 均为已启用、正在运行。Caddy 监听 80/443，Node 监听 `127.0.0.1:8787`。Caddy 本地 CA 根证书已由安装脚本生成；脚本输出的 TLS 校验结果为 `0`，站点证书包含 `DNS:char300.com`。
- 本机经 Caddy 实测：首页返回 HTTP 200；无 AI 配置时，翻译接口返回 HTTP 503 和“请先在服务器配置 AI 接口，再使用翻译功能。”。复查时 `.env` 只含站点地址和监听设置，没有 AI 密钥。
- `./start.sh` 在当前 Fedora 主机上实跑通过，重复执行后项目用户服务与 Caddy 仍正常运行，首页检查通过。首次缺少 `.env` 或 Caddy 时的分支尚需在新主机上验证。

## 当前部署边界与下一步

- 目前没有使用真实 AI 服务密钥做联调。要启用翻译，只在服务器本地 `.env` 填写所选服务的 API 地址前缀、模型和密钥，按模型接口选择 `AI_API_FORMAT`，然后运行 `systemctl --user restart char300.service`。不要把密钥提交到仓库或发送到聊天中。
- 其他局域网设备仍需把 `char300.com` 解析到服务器局域网 IP，信任该 Caddy 实例的根证书，并在服务器防火墙上按实际局域网区域放行 80/443。复查时这些跨设备步骤尚未验证。
- OPFS、Service Worker 注册和离线写作需要在已信任证书的实际浏览器上手工验收。迁移访问地址会改变浏览器存储 origin，应先从旧地址导出完整数据 ZIP，再从新地址导入。
- 站点仍按个人局域网使用设计，没有账户鉴权；不要将 Caddy 端口映射到公网。

## Git 节点

| 提交 | 内容 |
| --- | --- |
| `658c225`、`773e984`、`8bdbb90` | 翻译 API、页面交互及首版文档/验证流程。 |
| `40942de`、`8a80de3`、`47a20f2` | 整站 Caddy HTTPS、Fedora 安装脚本、环境变量示例。 |
| `7dae5a2`、`a364852` | 无 AI 配置启动及用户级常驻服务。 |
| `a14fc43` | 本次复查发现的错误提示、证书检查和文件读取修正。 |
