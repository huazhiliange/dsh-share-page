# dsh-share-page

把任意 **DeepSeek Harness（DSH）会话** 一键变成**可分享的只读静态网页** —— 自包含单文件 HTML（内联样式/脚本、零外部请求、离线可开），时间线渲染，可折叠工具调用与思考块，默认脱敏，双层 SHA-256 指纹防篡改，可选水印。

> 给同事、客户、读者看的会话快照：点击即开、不怕改、不泄密。

![Plugin preview — header 多了「分享」按钮](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/04-webui-header.png)

---

## 📑 目录

- [📸 它长什么样](#-它长什么样)
- [它解决什么问题](#它解决什么问题)
- [真正有用的场景（按价值排序）](#真正有用的场景按价值排序)
- [结论：它适合谁](#结论它适合谁)
- [功能特性](#功能特性)
- [快速开始（3 步）](#快速开始3-步)
- [安装](#安装)
- [使用方式](#使用方式)
  - [1. Web UI（推荐，主入口）](#1-web-ui推荐主入口)
  - [2. 斜杠命令](#2-斜杠命令)
  - [3. Agent 工具](#3-agent-工具)
  - [输出位置](#输出位置)
- [📸 分享页效果预览](#-分享页效果预览)
- [验证](#验证)
- [安全与隐私](#安全与隐私)
- [架构与实现](#架构与实现)
- [限制与 Roadmap](#限制与-roadmap)
- [License](#license)

---

## 📸 它长什么样

装上插件之后，DSH Web 会话 Header 右上角会多一颗「**分享**」按钮：

![Header 分享按钮](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/04-webui-header.png)

点开是一个轻量对话框，确认主题 / 脱敏 / 思考块 / 水印，一键生成：

![分享会话对话框](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/05-share-dialog.png)

> 默认脱敏 + 默认折叠思考 + 默认跟随系统主题，三项全部可以临时关掉。

生成的分享页长这样（可一键切换主题、展开/折叠工具）：

![分享页 meta 与时间线](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/06-share-page-meta.png)

![分享页对话时间线](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/07-share-page-timeline.png)

---

## 它解决什么问题

DSH 生态里已有的导出/分享能力，目标各不相同：

| 工具                                       | 产出            | 面向对象    |
| ---------------------------------------- | ------------- | ------- |
| 官方 `/export`                             | 原始 ZIP（JSONL） | 机器 / 续聊 |
| **本插件 `dsh-share-page`**                 | **可读的分享网页**   | **人**   |

**面向人的可读分享网页此前是空白** —— 本插件补上这一环：一份点击即开、离线可用、被改动就能发现的会话快照。

---

## 真正有用的场景（按价值排序）

| 场景                  | 为什么有用（简版）                                       |
| ------------------- | ----------------------------------------------- |
| ① 给同事/团队看「AI 是怎么干的」 | 分享页含完整时间线 / 思考过程 / 工具调用 / 报错，一次讲清「AI 做了什么、为什么」。 |
| ② 交付/评审留档           | 重要改动配一份可追溯的执行记录；页面含双层指纹防篡改。                     |
| ③ 给非技术的人看           | 老板、客户、业务方只关心结论与证据，分享页是排版好的版面。                   |
| ④ 长期归档/复盘/检索        | 自包含 HTML，可打印 PDF、离线存档、之后翻找。                     |
| ⑤ 分享给另一个 AI/工具      | 把一次漂亮 agent 操作导出为上下文喂给其他模型，或作内训示例。              |
| ⑥ 只读安全              | 默认脱敏（邮箱/密钥/路径）+ 水印 + 转义防注入；可放心外传。               |

---

## 结论：它适合谁

适合「**agent 产出需要对外沟通/留档/交付**」的用户 —— 团队协作、给客户交付、做重要自动化任务、想沉淀知识的人。如果你是重度使用 DSH 干活、且经常要「把过程拿给别人看」，它就有用。

---

## 功能特性

- **自包含单文件 HTML**：内联 CSS/JS、系统字体栈、零外部请求，断网也能打开；`Ctrl+P` 可直接打印 / 存 PDF。
- **时间线渲染**：用户 / 助手消息气泡、模型徽标（provider/model）、每轮 usage token 统计。
- **Markdown 渲染**：消息正文按 Markdown 渲染（标题 / 嵌套列表 / 代码块 / 表格 / 链接等），服务端生成、无 JS 也可读；内置极简渲染器（先转义后解析、零外部请求），思考过程与工具参数/结果保持纯文本。
- **可折叠工具调用**：`<details>` 卡片，参数 + 结果并排（错误结果红色标记），一键展开 / 折叠全部。
- **思考过程**：reasoning 块默认折叠展示（可关闭）。
- **默认脱敏**：邮箱、密钥（`sk-`/`AKIA`/`ghp_`/`Bearer`）、IPv4、Windows 绝对路径、长随机串自动替换；可关闭。
- **双层 SHA-256 指纹**（对齐 REQ-56 思想）：
  - **会话指纹**：规范化事件流（type+seq+data）的 SHA-256，随页面页脚展示，跨渲染可对比；
  - **文件指纹**：最终 HTML 字节的 SHA-256，由生成器返回，分享文件被改动即可用 `sha256sum` 校验出来。
- **水印**：页脚可注入分享者 / 日期等水印文本。
- **只读安全**：只用 `sessionPersistence.inspect/list` 消费会话日志，绝不 `load/prepare/append`，绝不改写历史事件。

---

## 快速开始（3 步）

```sh
# 1) 前置：已安装 dsh，且 Node.js ≥ 18
# 2) 从 npm 安装（推荐）
dsh plugin --profile web add dsh-share-page

# 3) 重启 dsh，会话 Header 右侧即出现「分享」按钮
dsh --profile web
```

打开任意会话 → 点 **分享** → 选好选项 → 生成。详见[使用方式](#使用方式)。

---

## 安装

```sh
# 从 npm 安装（推荐，自动获取最新版）：
dsh plugin --profile web add dsh-share-page

# 锁定版本（建议，DSH 处于开发者预览期，上游可能有破坏性变更）：
dsh plugin --profile web add dsh-share-page@0.1.0

# 本地路径安装（开发期 / 试用）：
dsh plugin --profile web add "file:<仓库绝对路径或相对路径>"
```

> 安装后**重启** `dsh --profile web`，会话 Header 右侧会出现「分享」按钮。

---

## 使用方式

### 1. Web UI（推荐，主入口）

会话 Header → **分享**（见 [Header 截图](#-它长什么样)） → 选项对话框：

| 选项                    | 默认值  | 说明                          |
| --------------------- | ---- | --------------------------- |
| **默认主题**              | 跟随系统 | 跟随系统 / 浅色 / 深色              |
| **脱敏**（邮箱/密钥/绝对路径/IP） | ✅ 开  | 默认开启；分享前在内容侧做正则替换，不依赖页面运行时。 |
| **包含思考过程**（折叠）        | ✅ 开  | reasoning 块默认折叠，可单击展开。      |
| **水印文本**（可选）          | 空    | 例如 `内部资料，请勿外传`，页脚展示。        |

对话框见 [分享会话对话框](#-它长什么样) 截图。

点「**生成分享页**」 → 弹窗显示 **输出路径** + **会话指纹** + **文件指纹**，并提供「复制路径」按钮。

### 2. 斜杠命令

```
/share                 # 无参时提示（当前会话 id 由 Web UI 按钮侧获取）
/share session-xxx     # 指定会话生成
```

### 3. Agent 工具

模型可直接调用 `share_session`，参数：

| 字段                 | 必填 | 说明                          |
| ------------------ | -- | --------------------------- |
| `sessionId`        | ✅  | 会话 ID                       |
| `redact`           | ❌  | 脱敏开关，默认 `true`              |
| `includeReasoning` | ❌  | 是否包含思考块，默认 `false`          |
| `theme`            | ❌  | `follow` / `light` / `dark` |
| `watermark`        | ❌  | 任意字符串，写入页脚                  |
| `outDir`           | ❌  | 输出目录，默认 `$DSH_HOME/shares`  |

返回 `{ path, size, sessionFingerprint, fileFingerprint, stats }`。

### 输出位置

默认 `$DSH_HOME/shares/<sessionId>.html`（`$DSH_HOME` 缺省 `~/.dsh`），可用 `outDir` 覆盖。

---

## 📸 分享页效果预览

生成的分享页是一个完整、离线可看、不会偷偷改你本地任何东西的只读网页。下面两张截图展示了一次「列出目录下文件」会话的渲染效果：

![meta 区与时间线概览](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/06-share-page-meta.png)

- 顶部是会话元数据卡片（时间 / 会话 ID / 模型 / 预设 / 工作目录 / 规模 / Token）；
- 下面有三个动作：**切换主题** / **展开全部工具** / **折叠全部工具**；
- 时间线呈现多轮 USER / ASSISTANT 消息，token 统计附着每条消息末尾。

![时间线展开——工具与表格](https://raw.githubusercontent.com/huazhiliange/dsh-share-page/master/docs/screenshots/07-share-page-timeline.png)

- 工具调用卡片以可折叠 `<details>` 形式呈现，参数 + 结果并排；
- 模型回复里 Markdown 表格被保留为原生表格；
- 页脚展示 **会话指纹** + **文件指纹**，可与 `sha256sum` 命令交叉校验。

---

## 验证

```sh
cd dsh-share-page
npm install          # 安装 fzstd（解压会话日志用）
npm run verify       # 真实会话渲染 + 注入转义 / 脱敏 / 指纹 18 项自检
```

也可手动指定会话（脱离 DSH 独立运行）：

```sh
node scripts/verify-render.mjs "C:\Users\you\.dsh\sessions" out
```

---

## 安全与隐私

- **转义优先**：所有动态内容（消息 / 工具输出 / 标题）一律 HTML 转义 —— 分享页可能被他人打开，agent 与工具输出不可信。
- **默认脱敏**：高置信模式（邮箱 / 密钥 / IP / 绝对路径 / 长随机串）默认替换，`redact:false` 显式关闭。
- **自包含 = 无外联**：页面不请求任何外部资源，打开它不会泄漏到第三方。
- **只读消费**：不写回会话、不触发修复、不调用删除。

---

## 架构与实现

```
dsh-share-page/
├── cordis.patch.yml          # bundle patch：insert service `session-share-page`
├── index.mjs                 # host 入口 apply(ctx)：工具 + 命令 + HTTP 路由
├── lib/
│   ├── render-html.mjs       # 事件流 → 分享页 HTML（纯函数，核心）
│   ├── markdown.mjs          # 极简 Markdown 渲染器（先转义后解析，零依赖）
│   ├── session-reader.mjs    # 会话读取（host: sessionPersistence.inspect；独立: fzstd+JSONL）
│   ├── redact.mjs            # 脱敏（纯函数）
│   ├── fingerprint.mjs       # 双层 SHA-256 指纹（纯函数）
│   └── locales.mjs           # host 端文案（zh/en）
├── client/
│   └── index.mjs             # Web UI 插件：会话 Header「分享」按钮 + 选项对话框
├── docs/screenshots/         # README 用到的效果截图
├── scripts/
│   └── verify-render.mjs     # 独立验证（真实会话渲染 + 注入转义/脱敏/指纹自检）
└── README.md
```

**分层与通道**：

| 层      | 角色                                                                                                                      | 通道                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| client | 会话 Header `conversation.session.header.utilities` 槽位注入「分享」按钮 + Modal（与官方 `dsh-session-log-export` 的 Session log 按钮同一机制） | `POST /api/session-share/render`      |
| host   | 渲染核心 + 写盘 + 指纹                                                                                                          | `ctx.sessionPersistence.inspect`（只读）  |
| agent  | 模型可直接调用 `share_session` 工具                                                                                              | `ctx.tools.register(defineTool(...))` |
| 命令     | `/share [sessionId]`（人类命令面，不占模型轮次）                                                                                      | `ctx.commands.register`               |

---

## 限制与 Roadmap

- [ ] 会话 **descendants / 附件** 纳入分享（当前只渲染根会话事件流）
- [ ] 浏览器内预览（大文件不返回 HTML 正文，仅返回路径）
- [ ] 会话列表选择器（当前经 Web UI 当前会话或显式 sessionId）
- [ ] 子代理（subagent）会话树展开
- [ ] 分享页内置「对照校验」：把文件指纹与页脚会话指纹做可视化比对

---

## License

MIT
