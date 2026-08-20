// index.mjs — dsh-share-page host 入口
//
// 把任意 DSH 会话变成「可分享的只读静态网页」：
//   - 自包含单文件 HTML（内联 CSS/JS、零外部请求、离线可开）
//   - 时间线渲染：用户/助手消息、可折叠工具调用与思考块
//   - 双层 SHA-256 指纹（会话级 + 文件级，损坏可检测）
//   - 默认脱敏（邮箱 / 密钥 / 绝对路径 / IP）+ 可选水印
//   - 只读消费会话日志：inspect/list，绝不 load/prepare/append
//
// 消费 host 服务：sessionPersistence（硬）、commands（可选）、webServer（可选）、
// tools（可选——ABI 版本不符时跳过工具注册，插件照常激活）。
//
// 入口面：
//   1. Web UI 会话 Header「分享」按钮（client 插件）→ POST /api/session-share/render
//   2. 斜杠命令 /share [sessionId]
//   3. Agent 工具 share_session（模型可直接生成分享页）

// 注意：@deepseek-ai/dsh-tools 是 peer 依赖且 ABI 版本敏感——顶层静态 import 会让
// 插件在工具服务缺失/版本不匹配时整体加载失败。因此工具注册改为 apply 内的动态
// import + try/catch 守卫：dsh-tools 不可解析或旧 ABI 时跳过工具注册，
// service / 命令 / HTTP 路由照常可用（Web UI 分享按钮不依赖工具）。

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { renderSessionPage } from './lib/render-html.mjs'
import { sessionFingerprint, fileFingerprint } from './lib/fingerprint.mjs'
import { inspectSession } from './lib/session-reader.mjs'
import { messages } from './lib/locales.mjs'

const name = 'session-share-page'

/** 输出目录：$DSH_HOME/shares（$DSH_HOME 缺省 ~/.dsh），可用 options.outDir 覆盖。 */
export function defaultShareDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'shares')
}

function safeFilename(sessionId) {
  return `session-${String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.html`
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function renderShare(ctx, sessionId, options = {}) {
  const m = messages(options.locale)
  if (!sessionId) throw new Error('sessionId is required')
  const { events } = await inspectSession(ctx, sessionId)
  if (!events || events.length === 0) throw new Error(m.sessionNotFound(sessionId))
  const out = renderSessionPage(events, {
    redact: options.redact !== false,
    includeReasoning: options.includeReasoning !== false,
    theme: ['auto', 'light', 'dark'].includes(options.theme) ? options.theme : 'auto',
    watermark: typeof options.watermark === 'string' ? options.watermark : '',
    title: typeof options.title === 'string' ? options.title : '',
  })
  const outDir = typeof options.outDir === 'string' && options.outDir ? options.outDir : defaultShareDir()
  await mkdir(outDir, { recursive: true })
  const filePath = join(outDir, safeFilename(sessionId))
  await writeFile(filePath, out.html, 'utf8')
  const info = await stat(filePath)
  return {
    path: filePath,
    size: info.size,
    sessionFingerprint: out.sessionFingerprint,
    fileFingerprint: fileFingerprint(out.html),
    stats: out.stats,
    redacted: options.redact !== false,
  }
}

function renderToolText(args, value) {
  const stats = value.stats || {}
  return [{
    type: 'text',
    text: [
      `分享页已生成：${value.path}`,
      `会话指纹：${value.sessionFingerprint}`,
      `文件指纹：${value.fileFingerprint}`,
      `规模：${stats.turns ?? 0} 轮 · ${stats.userMessages ?? 0} 问 · ${stats.assistantMessages ?? 0} 答 · ${stats.toolCalls ?? 0} 次工具调用`,
      `大小：${value.size} 字节${value.redacted ? '（已脱敏）' : '（未脱敏）'}`,
    ].join('\n'),
  }]
}

export function apply(ctx) {
  // sessionPersistence 是只读消费会话日志的硬需求；cordis 要求先注入才能访问。
  // 把 tools 一起注入，避免依赖解析层级不同导致 ctx.tools 不可见。
  ctx.inject(['sessionPersistence', 'tools'], (spCtx) => {
  // 1) Agent 工具：share_session
  //    tools 是可选 host 服务且 ABI 版本敏感（同 dsh-chat-import 的守卫）。
  //    动态 import + 守卫：@deepseek-ai/dsh-tools 不可解析或旧 ABI（缺
  //    TOOL_RUNTIME_SCHEDULER symbol）时跳过工具注册——插件照常激活，
  //    Web UI 按钮 / 命令 / 路由不受影响；绝不让工具 ABI 问题拖垮宿主。
  import('@deepseek-ai/dsh-tools').then(({ defineTool, TOOL_RUNTIME_SCHEDULER }) => {
    if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
      throw new Error('dsh-share-page: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires ^0.1.0-rc.6')
    }
    spCtx.tools.register(defineTool({
      name: 'share_session',
      description:
        '把指定 DSH 会话生成一份自包含的只读分享网页（单文件 HTML，内联样式/脚本、零外部请求、离线可开）。' +
        '包含完整时间线（用户/助手消息、可折叠工具调用与思考块）、双层 SHA-256 指纹与默认脱敏（邮箱/密钥/绝对路径/IP）。' +
        '只读消费会话日志，绝不改写历史事件。',
      parameters: {
        sessionId: { type: 'string', required: true, description: '要分享的 DSH 会话 id（如 session-xxx）。' },
        redact: { type: 'boolean', description: '可选：true（默认）脱敏邮箱/密钥/绝对路径/IP；false 保留原文。' },
        includeReasoning: { type: 'boolean', description: '可选：true（默认）包含思考过程（折叠展示）；false 省略。' },
        theme: { type: 'string', enum: ['auto', 'light', 'dark'], description: '可选：页面默认主题，默认 auto（跟随系统）。' },
        watermark: { type: 'string', description: '可选：页脚水印文本（如分享者/日期）。' },
        outDir: { type: 'string', description: '可选：输出目录（默认 $DSH_HOME/shares）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'size', 'sessionFingerprint', 'fileFingerprint', 'redacted', 'stats'],
          properties: {
            path: { type: 'string' },
            size: { type: 'integer' },
            sessionFingerprint: { type: 'string' },
            fileFingerprint: { type: 'string' },
            redacted: { type: 'boolean' },
            stats: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turns: { type: 'integer' },
                userMessages: { type: 'integer' },
                assistantMessages: { type: 'integer' },
                toolCalls: { type: 'integer' },
              },
            },
          },
        },
      },
      render: renderToolText,
      async execute(args) {
        return renderShare(spCtx, args.sessionId, args)
      },
    }))
  }).catch((err) => {
    spCtx.logger?.warn?.('[dsh-share-page] share_session tool not registered: ' + String((err && err.message) || err))
  })

  // 2) 斜杠命令 /share [sessionId]（commands 可选服务，缺席时命令不可用但插件照常激活）
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'share',
      description:
        '把当前会话（或指定会话）生成只读分享网页。用法：/share [sessionId] —— 无参会话时请在 Web UI 使用会话 Header 的「分享」按钮。',
      input: { hint: '[sessionId]' },
      async handler(invocation) {
        const m = messages()
        const raw = String(invocation.rawInput || '').trim()
        const sessionId = raw || (invocation.sessionId ? String(invocation.sessionId) : '')
        if (!sessionId) return { kind: 'error', text: m.usage }
        try {
          const value = await renderShare(spCtx, sessionId, {})
          return { kind: 'success', text: renderToolText({}, value)[0].text }
        } catch (err) {
          return { kind: 'error', text: m.renderFailed(String((err && err.message) || err)) }
        }
      },
    })
  })

  // 3) HTTP 路由（webServer 可选且晚挂载）：POST /api/session-share/render
  ctx.inject(['webServer'], (wsCtx) => {
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/session-share/render',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        try {
          const body = await readBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (!sessionId) return send(400, { ok: false, error: 'sessionId is required' })
          const value = await renderShare(spCtx, sessionId, body.options || {})
          send(200, { ok: true, ...value })
        } catch (err) {
          send(500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })

    // 4) 下载路由：GET /api/session-share/download?sessionId=...
    //    根据 sessionId 返回刚生成的 HTML 文件，触发浏览器自动下载。
    //    仅读取默认 shares 目录下由本插件生成的安全文件名，避免任意文件读取。
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/session-share/download',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        try {
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const sessionId = url.searchParams.get('sessionId')
          if (!sessionId) return send(400, { ok: false, error: 'sessionId is required' })
          const filePath = join(defaultShareDir(), safeFilename(sessionId))
          const info = await stat(filePath)
          if (!info.isFile()) return send(404, { ok: false, error: 'not found' })
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-disposition': `attachment; filename="${safeFilename(sessionId)}"`,
            'content-length': info.size,
          })
          createReadStream(filePath).pipe(res)
        } catch (err) {
          if (err && err.code === 'ENOENT') return send(404, { ok: false, error: 'not found' })
          send(500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
  })
  })
}

export { name }
