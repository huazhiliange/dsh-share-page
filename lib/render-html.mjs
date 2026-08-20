// lib/render-html.mjs — 会话事件流 → 自包含只读分享页（纯函数，零依赖，无 ctx）
//
// 输入：DSH 会话事件数组（sessionPersistence.inspect 返回的 SessionEvent[]，
//       或从 session.jsonl(.zstd) 解析的等价数组）。
// 输出：{ html, stats, sessionFingerprint }。
// 原则：
//   - 单文件自包含：内联 CSS/JS、系统字体栈、零外部请求，离线可开。
//   - 只读消费：不 load/prepare、不写回、不改写历史事件。
//   - 所有动态内容一律 HTML 转义（分享页可能被他人打开，agent/工具输出不可信）。
//   - 渐进增强：无 JS 时纯静态可读；有 JS 时支持主题切换、折叠、全文展开。

import { sha256Hex } from './fingerprint.mjs'
import { redactText } from './redact.mjs'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => escMap[c])
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return ''
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } catch {
    return String(ms)
  }
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m} min ${s} s`
}

function safeJoinText(blocks, redact) {
  const text = (blocks || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
  return redact ? redactText(text) : text
}

// ---------------------------------------------------------------------------
// 事件 → 会话视图（消息流 + 元信息 + 统计）
// ---------------------------------------------------------------------------

export function buildSessionView(events, options = {}) {
  const redact = options.redact !== false
  const ordered = [...(events || [])].sort((a, b) => {
    const sa = Number.isFinite(a.seq) ? a.seq : Infinity
    const sb = Number.isFinite(b.seq) ? b.seq : Infinity
    return sa - sb
  })

  let header = null
  let title = ''
  let model = ''
  let provider = ''
  let preset = ''
  const pendingCalls = new Map() // callId -> { name, arguments, time, attached }
  const messages = []
  let current = null // 正在构建的 assistant 消息
  let turn = 0
  let turnStart = 0
  const stats = {
    turns: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    startedAt: 0,
    endedAt: 0,
    firstUserText: '',
  }

  const flushCurrent = () => {
    if (current && current.toolCalls.length === 0 && current.text === '' && current.reasoning === '') {
      // 空助手消息（例如只有系统注入）不落流
    } else if (current) {
      messages.push(current)
      stats.assistantMessages += 1
    }
    current = null
  }

  for (const e of ordered) {
    const t = e.type
    const d = e.data || {}
    const time = Number.isFinite(e.time) ? e.time : Number.isFinite(e.time0) ? e.time0 : 0

    switch (t) {
      case 'session': {
        header = e
        preset = e.agentPreset || preset
        if (stats.startedAt === 0) stats.startedAt = e.createdAt || 0
        break
      }
      case 'session/title': {
        title = typeof d.title === 'string' ? d.title : title
        break
      }
      case 'request/header': {
        const cfg = d.header && d.header.config
        if (cfg) {
          model = cfg.model || model
          provider = cfg.provider || provider
        }
        break
      }
      case 'turn/start': {
        turn = d.turn || 0
        turnStart = time || turnStart
        break
      }
      case 'turn/end': {
        flushCurrent()
        if (turn > 0) stats.turns += 1
        stats.endedAt = Math.max(stats.endedAt, time || 0)
        break
      }
      case 'user/message': {
        flushCurrent()
        const text = safeJoinText(d.content, redact)
        const msg = { role: 'user', text, time, turn }
        messages.push(msg)
        stats.userMessages += 1
        if (!stats.firstUserText && text) stats.firstUserText = text.slice(0, 120)
        break
      }
      case 'assistant/message': {
        flushCurrent()
        const content = (d.message && d.message.content) || []
        const toolCalls = []
        for (const block of content) {
          if (block && block.type === 'tool-call') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: redact ? redactText(block.arguments) : block.arguments,
              resultText: '',
              isError: false,
              hasResult: false,
              resultTime: 0,
            })
          }
        }
        const reasoning = redact ? redactText(d.reasoningText || '') : (d.reasoningText || '')
        current = {
          role: 'assistant',
          text: safeJoinText(content, redact),
          reasoning,
          toolCalls,
          usage: d.usage || null,
          source: (d.message && d.message.source) || null,
          time,
          turn,
        }
        if (d.usage) {
          stats.inputTokens += d.usage.inputTokens || 0
          stats.outputTokens += d.usage.outputTokens || 0
          stats.reasoningTokens += d.usage.reasoningTokens || 0
        }
        for (const tc of toolCalls) pendingCalls.set(tc.id, { ...tc, attached: current })
        break
      }
      case 'tool/call': {
        // 兜底：独立 tool/call（无 assistant/message 载体时）也计入
        const key = d.callId
        if (key && !pendingCalls.has(key)) {
          pendingCalls.set(key, {
            id: key,
            name: d.name,
            arguments: redact ? redactText(d.arguments) : d.arguments,
            resultText: '',
            isError: false,
            hasResult: false,
            resultTime: 0,
            attached: null,
          })
        }
        break
      }
      case 'tool/result': {
        const callId = (d.message && d.message.source && d.message.source.callId) || (d.message && d.message.content && d.message.content[0] && d.message.content[0].toolCallId)
        const pending = callId ? pendingCalls.get(callId) : undefined
        if (!pending) break
        const block = (d.message && d.message.content && d.message.content[0]) || {}
        const inner = (block.content || [])
          .filter((b) => b && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
        pending.resultText = redact ? redactText(inner) : inner
        pending.isError = block.isError === true
        pending.hasResult = true
        pending.resultTime = time || 0
        pending.attached = pending.attached || current
        stats.toolCalls += 1
        if (pending.isError) stats.toolErrors += 1
        if (pending.attached) {
          const idx = pending.attached.toolCalls.findIndex((tc) => tc.id === callId)
          if (idx >= 0) {
            pending.attached.toolCalls[idx] = { ...pending }
          } else {
            pending.attached.toolCalls.push({ ...pending })
          }
        }
        break
      }
      case 'reasoning-chunks': {
        // 流式思考块（无 seq，seq0/time0/index/dt/texts）。聚合到当前 step 的 assistant 消息。
        if (!current) break
        const parts = Array.isArray(d.texts) ? d.texts : []
        if (parts.length > 0) {
          current.reasoning = (current.reasoning ? current.reasoning + '\n' : '') + parts.join('')
        }
        break
      }
      default:
        break // session/end-seed、permission/preset、sandbox/mode、approval/policy、
        // agent/inbox/spliced、step/start、step/end、assistant/chunk、text-chunks、
        // tool-call-chunks、request/context、todo/write、web/* 等均不进分享流
    }
  }
  flushCurrent()
  if (turn > 0 && stats.turns === 0) stats.turns = 1
  if (stats.startedAt === 0 && stats.endedAt === 0) stats.startedAt = header ? header.createdAt : 0

  return {
    header,
    title: options.title || title || (stats.firstUserText ? `会话 ${stats.firstUserText}` : 'DSH 会话'),
    model,
    provider,
    preset,
    messages,
    stats,
    cwd: redact ? redactText(header ? header.cwd : '') : (header ? header.cwd : ''),
  }
}

// ---------------------------------------------------------------------------
// HTML 渲染
// ---------------------------------------------------------------------------

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 16px 64px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--fg); line-height: 1.6;
}
body[data-theme="dark"] { --bg:#111418; --bg2:#171b21; --card:#1c2128; --fg:#e6e6e6; --fg-dim:#9aa4b2; --border:#2b313a; --accent:#4f9cf9; --accent-bg:rgba(79,156,249,.12); --user:#123a6b; --user-fg:#eaf3ff; --tool-border:#33404f; --ok:#3fb950; --err:#f85149; }
body[data-theme="light"] { --bg:#fafafa; --bg2:#f0f0f0; --card:#ffffff; --fg:#1f2328; --fg-dim:#57606a; --border:#d8dee4; --accent:#0969da; --accent-bg:rgba(9,105,218,.08); --user:#0969da; --user-fg:#ffffff; --tool-border:#d0d7de; --ok:#1a7f37; --err:#cf222e; }
@media (prefers-color-scheme: dark) { body:not([data-theme="light"]) { --bg:#111418; --bg2:#171b21; --card:#1c2128; --fg:#e6e6e6; --fg-dim:#9aa4b2; --border:#2b313a; --accent:#4f9cf9; --accent-bg:rgba(79,156,249,.12); --user:#123a6b; --user-fg:#eaf3ff; --tool-border:#33404f; --ok:#3fb950; --err:#f85149; } }
@media (prefers-color-scheme: light) { body:not([data-theme="dark"]) { --bg:#fafafa; --bg2:#f0f0f0; --card:#ffffff; --fg:#1f2328; --fg-dim:#57606a; --border:#d8dee4; --accent:#0969da; --accent-bg:rgba(9,105,218,.08); --user:#0969da; --user-fg:#ffffff; --tool-border:#d0d7de; --ok:#1a7f37; --err:#cf222e; } }

.share-header { max-width: 860px; margin: 0 auto; padding: 40px 0 24px; }
.share-header h1 { font-size: 24px; line-height: 1.35; margin: 0 0 12px; word-break: break-word; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.meta-item { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 12px; color: var(--fg-dim); }
.meta-item b { display: block; color: var(--fg); font-size: 13px; font-weight: 600; margin-top: 2px; word-break: break-all; }
.toolbar { max-width: 860px; margin: 8px auto 0; display: flex; gap: 8px; flex-wrap: wrap; }
.toolbar button {
  background: var(--accent-bg); color: var(--accent); border: 1px solid var(--border);
  border-radius: 16px; padding: 4px 14px; font-size: 12px; cursor: pointer;
}
.toolbar button:hover { border-color: var(--accent); }
.timeline { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; padding-top: 8px; }
.turn-divider { text-align: center; color: var(--fg-dim); font-size: 12px; border-top: 1px dashed var(--border); padding-top: 16px; margin-top: 8px; }
.msg { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; background: var(--card); }
.msg-user { background: var(--user); border-color: transparent; }
.msg-user .msg-text { color: var(--user-fg); }
.msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--fg-dim); }
.role-badge { font-weight: 600; font-size: 11px; letter-spacing: .4px; text-transform: uppercase; }
.msg-user .role-badge { color: var(--user-fg); opacity: .85; }
.msg-assistant .role-badge { color: var(--accent); }
.model-badge { background: var(--accent-bg); color: var(--accent); border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.msg-text { white-space: pre-wrap; word-break: break-word; }
.msg-text p { margin: 0 0 8px; }
.msg-text :last-child { margin-bottom: 0; }
details.reasoning, details.toolcall { margin-top: 10px; border: 1px solid var(--tool-border); border-radius: 8px; }
details.reasoning summary, details.toolcall summary { padding: 6px 12px; font-size: 12px; cursor: pointer; user-select: none; color: var(--fg-dim); }
details.reasoning[open] summary, details.toolcall[open] summary { border-bottom: 1px solid var(--tool-border); }
details.reasoning summary { color: var(--fg-dim); font-style: italic; }
details.toolcall[data-error="true"] summary { color: var(--err); }
.tool-name { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; color: var(--accent); }
pre.block {
  margin: 0; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: var(--bg2);
  border-radius: 0 0 8px 8px; overflow-x: auto;
}
details.toolcall pre.block { border-radius: 0; border-top: 1px solid var(--tool-border); }
pre.result-ok { color: var(--ok); }
pre.result-err { color: var(--err); }
.usage { margin-top: 10px; font-size: 11px; color: var(--fg-dim); }
.share-footer { max-width: 860px; margin: 48px auto 0; border-top: 1px solid var(--border); padding-top: 16px; font-size: 12px; color: var(--fg-dim); }
.share-footer .fp { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; word-break: break-all; }
.watermark { margin-top: 8px; color: var(--fg-dim); }
.notice { margin-top: 8px; color: var(--fg-dim); font-size: 11px; }
@media print { .toolbar { display: none; } body { padding-bottom: 16px; } details { border: 1px solid var(--border) !important; } }
`

const JS = `
(function () {
  function toggleTheme() {
    var body = document.body;
    var cur = body.getAttribute('data-theme');
    if (cur === 'dark') { body.setAttribute('data-theme', 'light'); }
    else if (cur === 'light') { body.removeAttribute('data-theme'); }
    else { body.setAttribute('data-theme', 'dark'); }
  }
  function setAllTools(open) {
    document.querySelectorAll('details.toolcall, details.reasoning').forEach(function (d) { d.open = open; });
  }
  window.__sharePage = { toggleTheme: toggleTheme, setAllTools: setAllTools };
})();
`

export function renderSessionPage(events, options = {}) {
  const view = buildSessionView(events, options)
  const { title, model, provider, preset, messages, stats, cwd } = view

  const fingerprint = sha256Hex(
    (events || [])
      .map((e) => JSON.stringify([e.type, Number.isFinite(e.seq) ? e.seq : Number.isFinite(e.seq0) ? e.seq0 : 0, e.data ?? null]))
      .join('\n'),
  )

  const metaItems = [
    ['时间', `${fmtTime(stats.startedAt)}${stats.endedAt > stats.startedAt ? ' → ' + fmtTime(stats.endedAt) : ''}`],
    ['会话 ID', view.header ? view.header.id : ''],
    ['模型', [provider, model].filter(Boolean).join(' / ') || '—'],
    ['预设', preset || '—'],
    ['工作目录', cwd || '—'],
    ['规模', `${stats.turns} 轮 · ${stats.userMessages} 问 · ${stats.assistantMessages} 答 · ${stats.toolCalls} 次工具调用`],
    ['Token', `${stats.inputTokens.toLocaleString()} in / ${stats.outputTokens.toLocaleString()} out${stats.reasoningTokens ? ' / ' + stats.reasoningTokens.toLocaleString() + ' reasoning' : ''}`],
  ]

  const body = messages.map((m) => {
    if (m.role === 'user') {
      return `<article class="msg msg-user">
  <div class="msg-meta"><span class="role-badge">User</span><time>${esc(fmtTime(m.time))}</time></div>
  <div class="msg-text msg-body">${esc(m.text)}</div>
</article>`
    }
    const parts = []
    parts.push(`<article class="msg msg-assistant">
  <div class="msg-meta"><span class="role-badge">Assistant</span>${model ? `<span class="model-badge">${esc(model)}</span>` : ''}<time>${esc(fmtTime(m.time))}</time></div>`)
    if (m.text) parts.push(`  <div class="msg-text msg-body">${esc(m.text)}</div>`)
    if (options.includeReasoning !== false && m.reasoning) {
      parts.push(`  <details class="reasoning"><summary>思考过程</summary><pre class="block">${esc(m.reasoning)}</pre></details>`)
    }
    for (const tc of m.toolCalls) {
      const err = tc.isError
      parts.push(`  <details class="toolcall" data-error="${err ? 'true' : 'false'}">
    <summary><span class="tool-name">${esc(tc.name || 'tool')}</span>${tc.hasResult ? (err ? ' ✗' : ' ✓') : ' …'}</summary>
    ${tc.arguments ? `<pre class="block">${esc(tc.arguments)}</pre>` : ''}
    ${tc.hasResult ? `<pre class="block result-${err ? 'err' : 'ok'}">${esc(tc.resultText)}</pre>` : ''}
  </details>`)
    }
    if (m.usage && (m.usage.inputTokens || m.usage.outputTokens)) {
      parts.push(`  <div class="usage">tokens: ${m.usage.inputTokens?.toLocaleString() ?? 0} in / ${m.usage.outputTokens?.toLocaleString() ?? 0} out${m.usage.reasoningTokens ? ' / ' + m.usage.reasoningTokens.toLocaleString() + ' reasoning' : ''}</div>`)
    }
    parts.push(`</article>`)
    return parts.join('\n')
  }).join('\n')

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="dsh-share-page">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body${options.theme === 'light' ? ' data-theme="light"' : options.theme === 'dark' ? ' data-theme="dark"' : ''}>
<header class="share-header">
  <h1>${esc(title)}</h1>
  <div class="meta-grid">
    ${metaItems.map(([k, v]) => `<div class="meta-item">${esc(k)}<b>${esc(v)}</b></div>`).join('\n')}
  </div>
</header>
<div class="toolbar">
  <button type="button" onclick="__sharePage.toggleTheme()">切换主题</button>
  <button type="button" onclick="__sharePage.setAllTools(true)">展开全部工具</button>
  <button type="button" onclick="__sharePage.setAllTools(false)">折叠全部工具</button>
</div>
<main class="timeline">
${body}
</main>
<footer class="share-footer">
  <div>会话指纹 <span class="fp">${fingerprint}</span></div>
  <div>由 DeepSeek Harness 生成 · ${esc(new Date().toISOString())}${esc(options.watermark ? ' · ' + options.watermark : '')}</div>
  <div class="watermark">${esc(options.watermark || '')}</div>
  <div class="notice">此页面为只读分享快照，非实时会话；内容来自会话日志${options.redact === false ? '（未脱敏）' : '（默认脱敏：邮箱/密钥/绝对路径/IP 已替换）'}。</div>
</footer>
<script>${JS}</script>
</body>
</html>
`

  return {
    html,
    stats,
    sessionFingerprint: fingerprint,
    view,
  }
}
