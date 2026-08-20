// lib/fingerprint.mjs — SHA-256 指纹（纯函数，node:crypto）
//
// 双层指纹（对齐 REQ-56 的会话级 + 文件级思想，此处用于分享页）：
//   - 会话指纹 sessionFingerprint：对规范化事件流（type + seq + data）做 SHA-256，
//     标识「这个会话的这次内容快照」；随页面页脚展示，可跨渲染对比。
//   - 文件指纹 fileFingerprint：对最终生成的 HTML 字节做 SHA-256，
//     由生成器写盘后返回；分享文件被改动即可被接收方校验出来。

import { createHash } from 'node:crypto'

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** 会话级指纹：规范化事件流 → SHA-256。 */
export function sessionFingerprint(events) {
  const normalized = (events || [])
    .map((e) => JSON.stringify([
      e.type,
      Number.isFinite(e.seq) ? e.seq : Number.isFinite(e.seq0) ? e.seq0 : 0,
      e.data ?? null,
    ]))
    .join('\n')
  return sha256Hex(normalized)
}

/** 文件级指纹：HTML 字节 → SHA-256。 */
export function fileFingerprint(html) {
  return sha256Hex(html)
}
