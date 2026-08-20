// lib/markdown.mjs — 极简 Markdown → HTML 渲染器（纯函数、零依赖）
//
// 用途：分享页消息正文的服务端 Markdown 渲染（生成时转好，页面零 JS 也可读，
// 与分享页「自包含 / 渐进增强」原则一致）。
//
// 安全模型（先转义后解析）：
//   输入先整体 HTML 转义（& < > " '），再做结构解析——任何注入的 HTML
//   标签天然变成实体文本，渲染器不输出任何未转义的输入内容，不存在 XSS 面。
//   链接 href 仅放行 http(s)://、/ 相对路径、# 锚点；javascript:/data: 等
//   协议按纯文本原样输出（不生成 <a>）。
//
// 支持子集（对 agent 输出够用，刻意不追求 CommonMark 全覆盖）：
//   标题 #~######、无序/有序列表（嵌套、续行）、fenced 代码块（带语言标注）、
//   行内代码、粗体/斜体/删除线、链接、裸 URL 自动链接、引用块、GFM 表格、
//   水平线、段落内单换行 → <br>（聊天记录可读性优先）。

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c])
}

// ---------------------------------------------------------------------------
// 行内渲染（输入须为已转义文本）
// ---------------------------------------------------------------------------

const CODE_SLOT = '\x00' // 行内代码占位符：防止 code 内容被后续规则二次处理

function safeHref(url) {
  return /^(https?:\/\/|\/|#)/i.test(url)
}

function inline(text) {
  const codes = []
  let t = String(text).replace(/(`+)([\s\S]*?)\1/g, (_m, fence, content) => {
    codes.push(`<code class="md-code">${content.trim() || content}</code>`)
    return `${CODE_SLOT}${codes.length - 1}${CODE_SLOT}`
  })

  // [label](url)（容忍可选 title；esc 后双引号呈 &quot;）
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    if (!safeHref(url)) return m
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })

  // 裸 URL 自动链接（要求前面是行首或空白/括号，避免命中已生成的 href="…"）
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)\x00]+)/g, (_m, pre, url) =>
    `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)

  // 粗体 / 斜体 / 删除线（粗体先行，斜体避开星号内侧）
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  t = t.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return t.replace(new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'), (_m, idx) => codes[Number(idx)] || '')
}

// ---------------------------------------------------------------------------
// 块级渲染（状态机 + 列表树）
// ---------------------------------------------------------------------------

const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const RE_HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const RE_FENCE = /^```\s*([\w+#.-]*)\s*$/
const RE_FENCE_END = /^```\s*$/
const RE_LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
// 注意：输入已先整体转义（">" → "&gt;"），引用标记须匹配转义后形态；
// 其余块级语法字符（# - * ` |）不受转义影响。
const RE_QUOTE = /^\s*&gt;/

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 收集连续列表行（item + 缩进续行），返回 [{ indent, ordered, start, text }]。 */
function collectListRows(lines, from) {
  const rows = []
  let j = from
  while (j < lines.length) {
    const m = RE_LIST_ITEM.exec(lines[j])
    if (m) {
      const marker = m[2]
      const ordered = /\d/.test(marker[0])
      rows.push({
        indent: m[1].length,
        ordered,
        start: ordered ? parseInt(marker, 10) : 1,
        text: m[3],
      })
      j += 1
      continue
    }
    // 懒惰续行：有缩进、非空、前面已有 item → 并入上一个 item（<br> 连接）
    if (rows.length > 0 && /^\s+\S/.test(lines[j])) {
      rows[rows.length - 1].text += '\n' + lines[j].trim()
      j += 1
      continue
    }
    break
  }
  return { rows, next: j }
}

/** 列表行 → 嵌套树。level = floor((indent - base) / 2)。 */
function buildListTree(rows) {
  const base = rows[0].indent
  const rootItems = []
  const stack = [] // [{ level, item }]
  for (const r of rows) {
    const level = Math.max(0, Math.floor((r.indent - base) / 2))
    const item = { row: r, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    if (stack.length === 0) rootItems.push(item)
    else stack[stack.length - 1].item.children.push(item)
    stack.push({ level, item })
  }
  return rootItems
}

function renderListTree(items) {
  if (items.length === 0) return ''
  const ordered = items[0].row.ordered
  const startAttr = ordered && items[0].row.start !== 1 ? ` start="${items[0].row.start}"` : ''
  let html = `<${ordered ? 'ol' : 'ul'}${startAttr}>`
  for (const it of items) {
    html += `<li>${inline(it.row.text).replace(/\n/g, '<br>')}`
    if (it.children.length > 0) html += renderListTree(it.children)
    html += '</li>'
  }
  return html + `</${ordered ? 'ol' : 'ul'}>`
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** Markdown 文本 → HTML 片段（段落/列表/表格等块级元素，无外层容器）。 */
export function renderMarkdown(src) {
  if (src == null || String(src) === '') return ''
  const lines = esc(src).split('\n')
  const out = []
  let para = []

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`)
      para = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // fenced 代码块：内容原样（已转义），不做任何行内解析
    const fence = RE_FENCE.exec(line)
    if (fence) {
      flushPara()
      const lang = fence[1]
      const buf = []
      let j = i + 1
      while (j < lines.length && !RE_FENCE_END.test(lines[j])) {
        buf.push(lines[j])
        j += 1
      }
      const openTag = lang ? `<code class="language-${esc(lang)}">` : '<code>'
      out.push(`<pre class="md-pre">${openTag}${buf.join('\n')}</code></pre>`)
      i = j < lines.length ? j + 1 : j
      continue
    }

    // 空行 → 段落结束
    if (line.trim() === '') {
      flushPara()
      i += 1
      continue
    }

    // 水平线
    if (RE_HR.test(line)) {
      flushPara()
      out.push('<hr class="md-hr">')
      i += 1
      continue
    }

    // 标题
    const heading = RE_HEADING.exec(line)
    if (heading) {
      flushPara()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    // 引用块（内部按行内 + <br> 渲染，不做嵌套块级）
    if (RE_QUOTE.test(line)) {
      flushPara()
      const quote = []
      let j = i
      while (j < lines.length && RE_QUOTE.test(lines[j])) {
        quote.push(lines[j].replace(/^\s*&gt;\s?/, ''))
        j += 1
      }
      out.push(`<blockquote class="md-quote">${inline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`)
      i = j
      continue
    }

    // GFM 表格：当前行含 |，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara()
      const header = splitRow(line)
      let j = i + 2
      const bodyRows = []
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
        bodyRows.push(splitRow(lines[j]))
        j += 1
      }
      let table = '<table class="md-table"><thead><tr>'
      table += header.map((c) => `<th>${inline(c)}</th>`).join('')
      table += '</tr></thead><tbody>'
      for (const row of bodyRows) {
        table += `<tr>${header.map((_h, k) => `<td>${inline(row[k] ?? '')}</td>`).join('')}</tr>`
      }
      out.push(table + '</tbody></table>')
      i = j
      continue
    }

    // 列表项
    if (RE_LIST_ITEM.test(line)) {
      flushPara()
      const { rows, next } = collectListRows(lines, i)
      out.push(renderListTree(buildListTree(rows)))
      i = next
      continue
    }

    // 普通段落行
    para.push(line)
    i += 1
  }
  flushPara()
  return out.join('\n')
}
