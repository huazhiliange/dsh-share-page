// lib/session-reader.mjs — 会话读取
//
// 双模式：
//   - host 模式：消费 ctx.sessionPersistence（官方只读 API），
//     inspect(id) 拿逻辑事件视图（自动处理 zstd / 逻辑修复，绝不写回），
//     list() 拿全部会话元信息。
//   - 独立模式：直接读 session.jsonl(.zstd) 文件（给验证脚本 / 无 ctx 环境用），
//     用 fzstd 解压，零系统依赖、零 child_process。
// 只读契约：本模块绝不调用 create/append/load/prepare 等写路径。

import { readFileSync } from 'node:fs'
import { decompress } from 'fzstd'

// ---- host 模式 -------------------------------------------------------------

/** 只读查看一个会话的逻辑事件流（inspect：只读、不提交修复、不发布）。 */
export async function inspectSession(ctx, sessionId, signal) {
  const { meta, events } = await ctx.sessionPersistence.inspect(sessionId, signal)
  return { meta, events }
}

/** 列出全部已物化会话的元信息（轻量，不解析完整日志）。 */
export async function listSessions(ctx, signal) {
  return ctx.sessionPersistence.list(signal)
}

// ---- 独立模式 --------------------------------------------------------------

/** 从 session.jsonl / session.jsonl.zstd 文件读取原始 JSONL 文本。 */
export function readSessionLogText(path) {
  const buf = readFileSync(path)
  if (/\.zstd$/i.test(path)) {
    return Buffer.from(decompress(new Uint8Array(buf))).toString('utf8')
  }
  return buf.toString('utf8')
}

/** 解析 JSONL 文本为事件数组（跳过空行与畸形行，畸形行计数返回）。 */
export function parseSessionLog(text) {
  const events = []
  let malformed = 0
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      malformed += 1
    }
  }
  return { events, malformed }
}
