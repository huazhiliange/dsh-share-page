# dsh-share-page

把任意 DeepSeek Harness 会话一键变成**可分享的只读静态网页**——自包含单文件 HTML（内联样式/脚本、零外部请求、离线可开），时间线渲染，可折叠工具调用与思考块，默认脱敏，双层 SHA-256 指纹防篡改，可选水印。

> 生态定位：DSH 官方 `/export` 下载的是**原始 ZIP（JSONL）**（给机器/续聊用），社区 `dsh-chat-import` / `dsh-session-share` 做的是**机器间数据迁移**；**面向人的可读分享网页是空白**——本插件补上这一环：给同事/客户/读者看的、双击即开、不怕改动的会话快照。

## 功能

- **自包含单文件 HTML**：内联 CSS/JS、系统字体栈、零外部请求，断网也能打开；`Ctrl+P` 可直接打印/存 PDF。
- **时间线渲染**：用户/助手消息气泡、模型徽标（provider/model）、每轮 usage token 统计。
- **可折叠工具调用**：`<details>` 卡片，参数 + 结果并排（错误结果红色标记），一键展开/折叠全部。
- **思考过程**：reasoning 块默认折叠展示（可关闭）。
- **默认脱敏**：邮箱、密钥（`sk-`/`AKIA`/`ghp_`/`Bearer`）、IPv4、Windows 绝对路径、长随机串自动替换；可关闭。
- **双层 SHA-256 指纹**（对齐 REQ-56 思想）：
  - 会话指纹：规范化事件流（type+seq+data）的 SHA-256，随页面页脚展示，跨渲染可对比；
  - 文件指纹：最终 HTML 字节的 SHA-256，由生成器返回，分享文件被改动即可被 `sha256sum` 校验出来。
- **水印**：页脚可注入分享者/日期等水印文本。
- **只读安全**：只用 `sessionPersistence.inspect/list` 消费会话日志，绝不 `load/prepare/append`，绝不改写历史事件。

## 架构

```
dsh-share-page/
├── cordis.patch.yml          # bundle patch：insert service `session-share-page`
├── index.mjs                 # host 入口 apply(ctx)：工具 + 命令 + HTTP 路由
├── lib/
│   ├── render-html.mjs       # 事件流 → 分享页 HTML（纯函数，核心）
│   ├── session-reader.mjs    # 会话读取（host: sessionPersistence.inspect；独立: fzstd+JSONL）
│   ├── redact.mjs            # 脱敏（纯函数）
│   ├── fingerprint.mjs       # 双层 SHA-256 指纹（纯函数）
│   └── locales.mjs           # host 端文案（zh/en）
├── client/
│   └── index.mjs             # Web UI 插件：会话 Header「分享」按钮 + 选项对话框
├── scripts/
│   └── verify-render.mjs     # 独立验证（真实会话渲染 + 注入转义/脱敏/指纹自检）
└── README.md
```

**分层与通道**：

| 层 | 角色 | 通道 |
|---|---|---|
| client | 会话 Header `conversation.session.header.utilities` 槽位注入「分享」按钮 + Modal（与官方 `dsh-session-log-export` 的 Session log 按钮同一机制） | `POST /api/session-share/render` |
| host | 渲染核心 + 写盘 + 指纹 | `ctx.sessionPersistence.inspect`（只读） |
| agent | 模型可直接调用 `share_session` 工具 | `ctx.tools.register(defineTool(...))` |
| 命令 | `/share [sessionId]`（人类命令面，不占模型轮次） | `ctx.commands.register` |

## 安装

```sh
# 本地路径安装（开发期）：
dsh plugin --profile web add "file:D:\workspace2\deepseek-harness-data\dsh-share-page"

# 发布到 npm 后（示意）：
dsh plugin --profile web add dsh-share-page
```

重启 `dsh --profile web` 后，会话 Header 右侧会出现「分享」按钮。

## 使用

### 1. Web UI（主入口）

会话 Header → **分享** → 选项对话框（默认主题 / 脱敏开关 / 思考块开关 / 水印）→ 生成分享页 → 显示输出路径 + 会话/文件指纹 + 复制路径。

### 2. 斜杠命令

```
/share                 # 无参时提示（当前会话 id 由 Web UI 按钮侧获取）
/share session-xxx     # 指定会话生成
```

### 3. Agent 工具

模型可直接调用 `share_session`，参数：`sessionId`（必填）、`redact`、`includeReasoning`、`theme`、`watermark`、`outDir`。返回 `{ path, size, sessionFingerprint, fileFingerprint, stats }`。

### 输出位置

默认 `$DSH_HOME/shares/<sessionId>.html`（`$DSH_HOME` 缺省 `~/.dsh`），可用 `outDir` 覆盖。

## 验证

```sh
cd dsh-share-page
npm install          # 安装 fzstd（解压会话日志用）
npm run verify       # 真实会话渲染 + 注入转义/脱敏/指纹 18 项自检
```

也可手动指定会话：

```sh
node scripts/verify-render.mjs "C:\Users\you\.dsh\sessions" out
```

## 安全与隐私

- **转义优先**：所有动态内容（消息/工具输出/标题）一律 HTML 转义——分享页可能被他人打开，agent 与工具输出不可信。
- **默认脱敏**：高置信模式（邮箱/密钥/IP/绝对路径/长随机串）默认替换，`redact:false` 显式关闭。
- **自包含 = 无外联**：页面不请求任何外部资源，打开它不会泄漏到第三方。
- **只读消费**：不写回会话、不触发修复、不调用删除。

## 限制与 Roadmap

- [ ] 会话 **descendants / 附件** 纳入分享（当前只渲染根会话事件流）
- [ ] Markdown 内容渲染（当前为纯文本 pre-wrap；已转义防注入）
- [ ] 浏览器内预览（大文件不返回 HTML 正文，仅返回路径）
- [ ] 会话列表选择器（当前经 Web UI 当前会话或显式 sessionId）
- [ ] 子代理（subagent）会话树展开
- [ ] 分享页内置「对照校验」：把文件指纹与页脚会话指纹做可视化比对

## License

MIT
