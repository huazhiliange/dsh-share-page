// lib/redact.mjs — 分享页脱敏（纯函数）
//
// 默认开启（options.redact !== false）。保守策略：只替换高置信模式，
// 宁可漏也不误伤正文；替换值统一为 <redacted>/<email>/<secret>/<ip>/<path>。

export function redactText(input) {
  if (typeof input !== 'string' || input === '') return input ?? ''
  return input
    // 常见密钥/令牌
    .replace(/\b(sk-[A-Za-z0-9_\-]{8,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|Bearer\s+[A-Za-z0-9._\-]{12,})\b/g, '<secret>')
    // 邮箱
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>')
    // IPv4
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    // Windows 绝对路径（盘符:\…，保留首尾段）
    .replace(/\b[A-Za-z]:\\[^\s<>"']{8,}\b/g, (m) => {
      const parts = m.split('\\').filter(Boolean)
      if (parts.length <= 3) return m
      return parts[0] + '\\…\\' + parts[parts.length - 1]
    })
    // 长随机串（≥24 位且含数字的字母数字下划线连字符串）→ 疑似 token/哈希
    .replace(/\b[A-Za-z0-9_\-]{24,}\b/g, (m) => (/\d/.test(m) ? '<token>' : m))
}
