// lib/locales.mjs — host 端错误/提示文案（client 端另有自己的 locale 注册）

export const MESSAGES = {
  zh: {
    sessionNotFound: (id) => `未找到会话：${id}`,
    renderFailed: (msg) => `分享页生成失败：${msg}`,
    usage: '用法：/share [sessionId] —— 生成当前会话（或指定会话）的只读分享页',
    shareResult: (v) => [
      `分享页已生成：${v.path}`,
      `会话指纹：${v.sessionFingerprint}`,
      `文件指纹：${v.fileFingerprint}`,
      `规模：${v.stats?.turns ?? 0} 轮 · ${v.stats?.userMessages ?? 0} 问 · ${v.stats?.assistantMessages ?? 0} 答 · ${v.stats?.toolCalls ?? 0} 次工具调用`,
      `大小：${v.size} 字节${v.redacted ? '（已脱敏）' : '（未脱敏）'}`,
    ].join('\n'),
  },
  en: {
    sessionNotFound: (id) => `Session not found: ${id}`,
    renderFailed: (msg) => `Failed to render share page: ${msg}`,
    usage: 'Usage: /share [sessionId] — generate a read-only share page for the current session (or the given one)',
    shareResult: (v) => [
      `Share page generated: ${v.path}`,
      `Session fingerprint: ${v.sessionFingerprint}`,
      `File fingerprint: ${v.fileFingerprint}`,
      `Scale: ${v.stats?.turns ?? 0} turns · ${v.stats?.userMessages ?? 0} user · ${v.stats?.assistantMessages ?? 0} assistant · ${v.stats?.toolCalls ?? 0} tool calls`,
      `Size: ${v.size} bytes${v.redacted ? ' (redacted)' : ' (not redacted)'}`,
    ].join('\n'),
  },
}

export function messages(locale = 'zh') {
  return MESSAGES[locale] || MESSAGES.zh
}
