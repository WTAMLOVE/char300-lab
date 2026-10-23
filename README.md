# 逐字

让每一次修改都被看见。

逐字是一个本地优先的每日写作与版本打磨工具。它记录从草稿到终稿的修改轨迹：每天写作、保存版本、查看 token 级 diff，并在阅读流和总览里回看自己的写作节奏。

## 功能

- 每日写作：按自然日管理练习，支持回到今日和历史回看。
- 版本链：每次保存生成一个不可覆盖的版本，保留相邻版本 diff。
- 阅读流与总览：浏览每日终稿，查看年度格、写作天数、连击和每日数据。
- 统计提示：显示 300 字标尺，并统计汉字、标点、连续数字等 token。
- 主题与离线：支持跟随系统、日间、夜间；首次在线加载后可离线继续使用。
- 导出与恢复：支持分享图片、Markdown、完整数据 ZIP、轻量分析 JSON，以及 ZIP/JSON 导入恢复。
- 按需翻译：点击后把当前草稿或正在查看的版本译成自然英文，原文与译文对照阅读；译文不改写文章。

## 当前版本

0.4.0 新增按需英文翻译，可配置 OpenAI 兼容服务。

## 运行

需要 Node.js 22 和 pnpm 11。先复制 `.env.example` 为 `.env`；不配置 AI 服务也能启动站点，点击翻译时会提示先配置 AI 接口。示例默认用于 `https://char300.com` 的 Caddy 部署；本机 Vite 开发时把 `APP_ORIGIN` 改为 `http://127.0.0.1:5173`。开发时分别启动页面和接口：

```bash
pnpm install
cp .env.example .env
pnpm run dev:api
# 在另一个终端运行
pnpm run dev
```

默认访问地址：

```text
http://127.0.0.1:5173/
```

生产构建和本机启动（同一地址提供页面与翻译接口）：

```bash
pnpm run build
pnpm run start
```

默认监听 `127.0.0.1:8787`。局域网部署使用根目录的 `Caddyfile`，以 `https://char300.com` 作为**整个站点**的入口：页面、静态资源、Service Worker 和翻译接口都使用同一域名和证书。部署步骤见 [局域网 HTTPS 部署](docs/LAN_HTTPS.md)。本机开发仍可访问 `http://127.0.0.1:5173/`。

翻译服务配置项：

| 变量 | 含义 |
| --- | --- |
| `AI_API_FORMAT` | `chat-completions` 或 `responses`；不填写时默认前者。 |
| `AI_API_BASE_URL` | 所选服务的 API 地址前缀，不包含最终的 `/chat/completions` 或 `/responses`。 |
| `AI_MODEL` | 所选服务支持的模型 ID。 |
| `AI_API_KEY` | 仅供服务端读取的密钥；不要提交 `.env`。 |

启用翻译时，在 `.env` 中同时填写所选服务的 `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY`，按模型支持的接口选择 `AI_API_FORMAT`。例如 OpenAI Responses 可用 `AI_API_FORMAT=responses`、`AI_API_BASE_URL=https://api.openai.com/v1`；DeepSeek Chat Completions 可用 `AI_API_FORMAT=chat-completions`、`AI_API_BASE_URL=https://api.deepseek.com`。其他兼容服务也按其文档填写地址前缀与模型。更换服务后重启项目服务。未配置或配置不完整时，写作和浏览正常可用，点击翻译会提示配置 AI 接口；翻译本身需要连接所选服务。

## 数据与备份

写作数据保存在当前浏览器、当前访问地址对应的本地存储中，优先使用 OPFS，并保留 localStorage 作为兼容兜底。应用不会自动上传文章；**只有点击“翻译成英文”时**，当前正文才会经本机翻译接口发送给 `.env` 中配置的 AI 服务，可能产生该服务的费用。译文只保留在当前页面内存，刷新后消失，也不进入备份。

这意味着：

- 换浏览器后，看不到原浏览器里的数据。
- 换地址或端口后，可能看到另一份数据，例如 `localhost:5173` 和 `127.0.0.1:5173` 是不同 origin。
- 清理站点数据、重置浏览器资料或关闭无痕窗口，都可能删除本地数据。

认真使用时，建议定期备份：

```text
导出 → 完整数据 ZIP
```

如果只需要结构化数据，也可以使用：

```text
导出 → 轻量分析 JSON
```

完整数据 ZIP 包含：

- `zhuzi-data.json`：可导入恢复的完整数据。
- `analysis/zhuzi-analysis.json`：不含完整 token diff、包含相邻版本 diff 摘要的轻量分析数据，也可导入恢复。
- `markdown/all.md`：全部终稿的 Markdown 汇总。
- `markdown/days/*.md`：每天单独一份 Markdown。

独立导出的 `逐字-analysis-YYYY-MM-DD.json` 与 ZIP 内的 `analysis/zhuzi-analysis.json` 内容一致。它保留完整档案、每个版本的正文、换行、身份与时间字段，并以 `diff_summary` 提供修改统计；为控制体积，不包含逐 token 的 `diff_from_previous`。导入时，逐字会根据相邻版本正文重建完整 diff。

ZIP 导入固定优先采用 `zhuzi-data.json`；它缺失或 JSON 损坏时才回退到轻量分析文件。旧版 `char300-lab-data.json` 和旧的独立完整 JSON 继续兼容。

恢复方式：

```text
导出 → 从 ZIP/JSON 导入
```

导入会替换当前环境里的本地档案。导入前请确认当前内容已经备份。

## 自动化读取

推荐先手动使用“轻量分析 JSON”，复制应用提供的分析提示词，再把提示词和 JSON 文件一起交给 LLM。

逐字也提供页面内只读 API，适合油猴脚本或已连接到当前页面的浏览器 Agent。它不是 HTTP API。普通 Playwright 新开的浏览器没有用户原 Chrome 里的逐字数据；自动化脚本需要连接到已有数据的浏览器上下文，或由用户先打开逐字页面后再调用：

```js
const payload = await page.evaluate(() => window.zhuzi.getBackupPayload());
const json = await page.evaluate(() => window.zhuzi.exportJson());
const prompt = await page.evaluate(() => window.zhuzi.getAnalysisPrompt());
```

`getBackupPayload()` 返回包含完整 diff 的备份快照；`exportJson()` 返回不含完整 diff、包含 `diff_summary` 的格式化分析 JSON；`getAnalysisPrompt()` 返回界面中可复制的 LLM 分析提示词。

## 数据说明

`Entry` 表示某一天的写作容器；`Version` 表示每次保存后的完整文本快照。历史版本不可覆盖，只追加。

统计规则：

- 汉字：1 单位。
- 标点：1 单位。
- 连续数字：合并为 1 个数字 token。

例如 `2026年写100字。` 中，`2026` 是 1 个数字 token，`100` 也是 1 个数字 token。

## 常用命令

```bash
pnpm run dev       # 启动开发页面
pnpm run dev:api   # 启动本机翻译接口
pnpm run build     # 构建网页
pnpm run start     # 同源提供构建页面和翻译接口
pnpm test          # 运行单元测试
pnpm run benchmark # 生成合成长档案性能基线
pnpm run check     # 运行版本、测试、类型与生产构建检查
```
