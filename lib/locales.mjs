// lib/locales.mjs — host 端错误/提示文案（client 端另有自己的 locale 注册）

export const MESSAGES = {
  zh: {
    sessionNotFound: (id) => `未找到会话：${id}`,
    renderFailed: (msg) => `分享页生成失败：${msg}`,
    usage: '用法：/share [sessionId] —— 生成当前会话（或指定会话）的只读分享页',
  },
  en: {
    sessionNotFound: (id) => `Session not found: ${id}`,
    renderFailed: (msg) => `Failed to render share page: ${msg}`,
    usage: 'Usage: /share [sessionId] — generate a read-only share page for the current session (or the given one)',
  },
}

export function messages(locale = 'zh') {
  return MESSAGES[locale] || MESSAGES.zh
}
