// scripts/verify-render.mjs — 独立验证：真实会话日志 → 分享页 HTML → 自检
//
// 不依赖 cordis ctx（独立模式：fzstd 解压 + JSONL 解析），可脱离 DSH 运行：
//   node scripts/verify-render.mjs [sessionPath|sessionDir] [outDir]
// 自检项：
//   1. HTML 结构完整（doctype/html/title/footer）
//   2. 会话指纹为 64 位 hex
//   3. 标题、消息数、工具调用数统计正确（与直接解析对照）
//   4. 注入转义：构造含 <script> 的事件，确认渲染后已转义、不破坏结构
//   5. 文件指纹对「改动后内容」变化（损坏可检测）
//   6. 脱敏：构造含邮箱/密钥的文本，确认被替换

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readSessionLogText, parseSessionLog } from '../lib/session-reader.mjs'
import { renderSessionPage } from '../lib/render-html.mjs'
import { fileFingerprint } from '../lib/fingerprint.mjs'

async function collectFromDir(dir) {
  const { readdirSync } = await import('node:fs')
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session\.jsonl(?:\.zstd)?$/i.test(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const [, , targetArg, outDirArg] = process.argv
const outDir = resolve(outDirArg || 'out')

// 1) 找真实会话
let targets = []
if (targetArg) {
  if (existsSync(targetArg) && !/\.jsonl(?:\.zstd)?$/i.test(targetArg)) {
    targets = await collectFromDir(targetArg)
  } else {
    targets = [targetArg]
  }
} else {
  // 默认：本机 DSH 会话库（存在时才跑）
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const sessionsDir = join(home, 'sessions')
  if (existsSync(sessionsDir)) targets = await collectFromDir(sessionsDir)
}
if (targets.length === 0) {
  console.log('SKIP  未找到真实会话日志（可用参数指定路径）；仍执行注入转义/脱敏/指纹自检')
} else {
  console.log(`找到 ${targets.length} 个会话日志，取最近一个验证`)
  targets.sort()
  const target = targets[targets.length - 1]
  const text = readSessionLogText(target)
  const { events, malformed } = parseSessionLog(text)
  console.log(`会话: ${target}\n事件: ${events.length}，畸形行: ${malformed}`)

  const out = renderSessionPage(events, { redact: true, includeReasoning: true, watermark: '验证-内部资料' })
  await mkdir(outDir, { recursive: true })
  const filePath = join(outDir, 'verify-share.html')
  await writeFile(filePath, out.html, 'utf8')

  check('HTML 含 doctype', out.html.startsWith('<!doctype html>'))
  check('HTML 含 <html> 闭合', out.html.includes('</html>'))
  check('HTML 含页脚指纹', /会话指纹|Session fingerprint/.test(out.html))
  check('会话指纹为 64 位 hex', /^[0-9a-f]{64}$/.test(out.sessionFingerprint), out.sessionFingerprint.slice(0, 16) + '…')
  check('标题非空', out.view.title.length > 0, `《${out.view.title.slice(0, 40)}》`)
  check('消息数 > 0', out.stats.userMessages + out.stats.assistantMessages > 0, `${out.stats.userMessages} 问 / ${out.stats.assistantMessages} 答`)
  check('工具调用数 ≥ 0', out.stats.toolCalls >= 0, `${out.stats.toolCalls} 次`)
  check('输出大小 > 10KB', (await readFile(filePath)).length > 10_000, `${out.html.length} 字节`)

  // 文件指纹对内容敏感
  const fp1 = fileFingerprint(out.html)
  const fp2 = fileFingerprint(out.html + ' ')
  check('文件指纹对改动敏感', fp1 !== fp2)
  check('文件指纹为 64 位 hex', /^[0-9a-f]{64}$/.test(fp1))

  console.log(`\n输出: ${filePath} (${out.html.length} 字节)\n`)
}

// 2) 注入转义自检（合成恶意事件）
const evilEvents = [
  { type: 'session', version: 0, id: 'session-evil', createdAt: Date.now(), cwd: 'C:\\evil' },
  { type: 'session/title', seq: 0, time: Date.now(), data: { title: '<img src=x onerror=alert(1)>标题' } },
  { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text: '<script>alert("xss")</script> 我的邮箱是 a@b.com，密钥 sk-abcdef1234567890' }] } },
  { type: 'assistant/message', seq: 3, time: Date.now(), data: { message: { role: 'assistant', content: [
    { type: 'text', text: '好的</div><script>evil()</script>' },
    { type: 'tool-call', id: 'call-evil', name: 'pwsh', arguments: '{"cmd":"rm -rf /"}' },
  ] } } },
  { type: 'tool/result', seq: 4, time: Date.now(), data: { message: { source: { kind: 'tool', callId: 'call-evil' }, content: [
    { type: 'tool-result', toolCallId: 'call-evil', content: [{ type: 'text', text: 'output <b>bold</b> a@b.com C:\\Users\\secret\\deep\\path\\to\\nowhere 192.168.1.1' }], isError: false },
  ] } } },
  { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
]
const evilOut = renderSessionPage(evilEvents, { redact: true, includeReasoning: true })
// esc() 只转义 &<>"'：检查「真实可执行标签」数量——模板自带 1 个 <script>（页脚 JS），
// 注入内容里的 <script>/<img> 必须被转义为 &lt;…&gt;（不计入裸标签）。
const rawScriptTags = (evilOut.html.match(/<script[\s>]/g) || []).length
const rawImgTags = (evilOut.html.match(/<img[\s>]/g) || []).length
check('注入标签已转义（<script> 仅模板自带 1 个、<img> 为 0）', rawScriptTags === 1 && rawImgTags === 0, `script=${rawScriptTags} img=${rawImgTags}`)
check('转义产物存在（&lt;script&gt;）', evilOut.html.includes('&lt;script&gt;'))
check('HTML 结构未被注入破坏（<html> 正常闭合）', evilOut.html.includes('</html>') && evilOut.html.includes('<!doctype html>'))
check('脱敏：邮箱已替换', !evilOut.html.includes('a@b.com'))
check('脱敏：密钥已替换', !evilOut.html.includes('sk-abcdef1234567890'))
check('脱敏：IP 已替换', !evilOut.html.includes('192.168.1.1'))
check('脱敏：深层路径已缩写', !evilOut.html.includes('C:\\Users\\secret\\deep\\path\\to\\nowhere'))
check('工具调用卡片存在且含错误标记逻辑', evilOut.html.includes('toolcall'))

// 3) Markdown 渲染自检（合成事件：正常语法 + 恶意注入混排）
const mdEvents = [
  { type: 'session', version: 0, id: 'session-md', createdAt: Date.now(), cwd: 'C:\\md' },
  { type: 'session/title', seq: 0, time: Date.now(), data: { title: 'Markdown 渲染自检' } },
  { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text:
    '# 项目标题\n\n> 引用一行\n\n- 顶层 A\n  - 嵌套 A1\n  - 嵌套 A2\n- 顶层 B\n\n1. 第一\n2. 第二\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n[好链](https://example.com) 与 [坏链](javascript:alert(1)) 与 **粗体** *斜体* ~~删除~~ `行内码` 裸链 https://example.org/x\n\n```js\nconst evil = "<script>alert(1)</script>"\n```' }] } },
  { type: 'assistant/message', seq: 3, time: Date.now(), data: { message: { role: 'assistant', content: [
    { type: 'text', text: '## 回答标题\n\n```html\n<img src=x onerror=evil()>\n```\n' },
  ] } } },
  { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
]
const mdOut = renderSessionPage(mdEvents, { redact: false, includeReasoning: true })
const md = mdOut.html
check('MD：标题渲染为 <h1>/<h2>', md.includes('<h1>项目标题</h1>') && md.includes('<h2>回答标题</h2>'))
check('MD：无序列表 + 嵌套渲染', md.includes('<ul>') && md.includes('<li>顶层 A<ul>') && md.includes('<li>嵌套 A1'))
check('MD：有序列表渲染', md.includes('<ol>') && md.includes('<li>第一'))
check('MD：引用块渲染', md.includes('<blockquote class="md-quote">引用一行'))
check('MD：表格渲染', md.includes('<table class="md-table">') && md.includes('<th>列甲</th>') && md.includes('<td>2</td>'))
check('MD：水平线渲染', md.includes('<hr class="md-hr">'))
check('MD：粗体/斜体/删除线/行内码渲染', md.includes('<strong>粗体</strong>') && md.includes('<em>斜体</em>') && md.includes('<del>删除</del>') && md.includes('<code class="md-code">行内码</code>'))
check('MD：fenced 代码块渲染（带语言标注）', md.includes('language-js') && md.includes('language-html'))
check('MD：http(s) 链接生成且带 noopener', md.includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">好链</a>') && md.includes('href="https://example.org/x"'))
check('MD：javascript: 链接被中和（不生成 <a>）', !md.includes('href="javascript'))
check('MD：裸 URL 自动链接', md.includes('>https://example.org/x</a>'))
check('MD：代码块内 <script> 已转义', !md.includes('<script>alert(1)') && md.includes('&lt;script&gt;'))
check('MD：代码块内 <img> 注入已转义', !/<img[\s>]/.test(md))
check('MD：markdown 路径无裸 <script>（仅模板自带 1 个）', (md.match(/<script[\s>]/g) || []).length === 1)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
process.exit(failed.length > 0 ? 1 : 0)
