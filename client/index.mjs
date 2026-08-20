// client/index.mjs — dsh-share-page Web UI 插件
//
// 会话 Header 注入「分享」按钮（conversation.session.header.utilities 槽位，
// 与官方 dsh-session-log-export 的 Session log 按钮同一机制）→ Modal：
//   - 选项：默认主题 / 脱敏开关 / 思考块开关 / 水印
//   - 提交：POST /api/session-share/render（host webServer 路由）
//   - 结果：显示输出路径、会话/文件指纹、规模统计、复制路径
//
// 纯 JS + React jsx-runtime 手写（不依赖 JSX 构建），开箱即用。
// 注意：dsh web 使用 React 17+ 的 jsx-runtime，children 必须放在 props.children
// 里；不能把 children 当第三个参数传（第三个参数是 key）。

window.__ModuleLoader__.load({
  id: 'dsh-share-page',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react/jsx-runtime：官方 client bundle 使用 jsx/jsxs/Fragment。
    // 我们用一个小包装 e() 让 children 写法保持直观，同时符合 jsx-runtime 约定。
    const { jsx: h, jsxs: hs, Fragment } = require('react/jsx-runtime')
    const React = require('react')
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')

    // 包装：把多余的参数收集成 props.children，避免直接调用 h(type, props, child)
    // 时被当成 key 参数。
    const e = (type, props, ...children) => {
      const p = props || {}
      if (children.length === 0) return h(type, p)
      if (children.length === 1) return h(type, { ...p, children: children[0] })
      return hs(type, { ...p, children })
    }

    // -------------------------------------------------------------------------
    // 状态与控制器
    // -------------------------------------------------------------------------

    const NS = 'share-page'
    const INITIAL = { bySession: {} }

    // 第三方插件不能 require('@deepseek-ai/dsh-client-runtime/client')——
    // dsh web 的 module table 只 seed 9 个 platform 模块（见
    // packages/client/web/src/seed.ts），runtime/client 不在里面，require
    // 会抛 "missed the module table"，client bundle 整包被拒，UI 看起来
    // 正常但插件静默失效。第三方插件必须自实现 SnapshotStore：
    //   getSnapshot / subscribe（slot registry 用 uSES 绑成 use<Name> hook）
    //   update / set（mutator 自己改 state）
    // 同步 flush（不分 RAF），不持久化——dweb 客户端事件频率低，够用。
    const createSnapshotStore = (init) => {
      let state = init
      const listeners = new Set()
      const notify = () => { for (const fn of [...listeners]) fn() }
      return {
        getSnapshot: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        update: (mutator) => {
          // 简单浅拷贝 + draft 模式：mutator 写 next.X = ...，只在 next 上改，
          // 与 immer 语义对 `{ bySession: { [id]: entry } }` 这种扁 state 等价。
          const next = { ...state }
          mutator(next)
          state = next
          notify()
        },
        set: (next) => { state = next; notify() },
      }
    }

    function hostBase() {
      const origin = globalThis.location?.origin
      return origin !== void 0 && origin !== 'null' ? origin : 'http://dsh.internal'
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    var SharePageController = class {
      constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher
        this.store = createSnapshotStore(INITIAL)
        this.active = new Map()
        this.disposed = false
      }
      open(sessionId) {
        this.publish(sessionId, { open: true, status: 'idle', error: null, result: null })
      }
      dismiss(sessionId) {
        const current = this.store.getSnapshot().bySession[String(sessionId)]
        if (current === void 0 || !current.open) return
        this.publish(sessionId, { ...current, open: false })
      }
      async generate(sessionId, options) {
        const existing = this.active.get(sessionId)
        if (existing !== void 0) return existing.done
        if (this.disposed) return Promise.resolve()
        const done = this.run(sessionId, options).finally(() => this.active.delete(sessionId))
        this.active.set(sessionId, { done })
        return done
      }
      async run(sessionId, options) {
        this.publish(sessionId, { open: true, status: 'generating', error: null, result: null })
        try {
          const url = new URL('/api/session-share/render', hostBase())
          const response = await this.fetcher(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, options: options || {} }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
          this.publish(sessionId, { open, status: 'success', error: null, result: payload })
        } catch (error) {
          if (this.disposed) return
          const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
          this.publish(sessionId, { open, status: 'error', error: messageOf(error), result: null })
        }
      }
      publish(sessionId, entry) {
        this.store.update((state) => {
          state.bySession = { ...state.bySession, [String(sessionId)]: entry }
        })
      }
      async dispose() {
        this.disposed = true
        await Promise.allSettled([...this.active.values()].map((op) => op.done))
      }
    }

    // -------------------------------------------------------------------------
    // 样式（data-plugin-css 注入，避免与宿主样式冲突）
    // -------------------------------------------------------------------------

    const css = [
      '.sharePageButton{border:1px solid var(--dsw-alias-border-l2);min-width:111px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex}',
      '.sharePageButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.sharePageButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}',
      '.sharePageButton span,.sharePageButton svg{flex:none}',
      '.sharePageButton span{white-space:nowrap}',
      '.sharePageField{display:flex;flex-direction:column;gap:4px;margin-bottom:12px;font-size:13px}',
      '.sharePageField label{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.sharePageField input[type=text],.sharePageField select{height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);padding:0 8px;font-size:13px}',
      '.sharePageResult{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.sharePageResult code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary)}',
      '.sharePageRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    ].join('')
    const tagId = 'dsh-share-page/styles.css'
    // 属性选择器值是字符串字面量，不能用 JSON.stringify（那会包一层双引号，
    // 拼出来变成 style[data-plugin-css=""dsh-share-page/styles.css""]，直接
    // 让 querySelector 抛 SyntaxError——DSH client loader 会把这个错冒泡成
    // "Failed to execute 'querySelector'" 然后拒绝整个 client bundle，导致
    // dsh web 启动白屏）。这里 tagId 不含引号/反斜杠/方括号，直接拼即可。
    let styleTagMissing = false
    if (typeof document !== 'undefined') {
      try {
        styleTagMissing = document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
      } catch {
        styleTagMissing = true
      }
    }
    if (styleTagMissing) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-share-page'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // 组件
    // -------------------------------------------------------------------------

    function safeFilename(sessionId) {
      const base = String(sessionId || 'share').replace(/[^A-Za-z0-9_-]/g, '_')
      return `${base}.html`
    }

    function openShareInNewTab(sessionId) {
      // 用 <a target="_blank" rel="noopener noreferrer"> 模拟点击，
      // 比 window.open 更稳：跟随用户手势不会被浏览器弹窗拦截。
      // 不带 download 属性 → 浏览器走导航语义（看服务端
      // content-disposition 决定 inline 还是下载）；服务端 header
      // 已设为 inline，因此新 tab 直接渲染 HTML。
      const link = document.createElement('a')
      link.href = new URL(
        `/api/session-share/download?sessionId=${encodeURIComponent(String(sessionId))}`,
        hostBase(),
      ).href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      link.remove()
    }

    function ShareDialog(props) {
      const { sessionId, useSessionSharePage, request, dismiss, t } = props
      const entry = useSessionSharePage((state) => state.bySession[String(sessionId)])
      const status = entry?.status || 'idle'
      const open = entry?.open === true
      const result = entry?.result || null
      const error = status === 'error' ? entry?.error || t('dialog.failedGeneric') : null
      const prevStatusRef = React.useRef(null)

      React.useEffect(() => {
        if (prevStatusRef.current !== 'success' && status === 'success' && result?.path) {
          openShareInNewTab(sessionId)
        }
        prevStatusRef.current = status
      }, [status, result, sessionId])

      const copyPath = () => {
        if (result && result.path) {
          const done = () => {}
          try {
            navigator.clipboard.writeText(result.path).then(done, done)
          } catch {
            done()
          }
        }
      }

      let body
      if (status === 'generating') {
        body = e('div', { className: 'sharePageResult' }, t('dialog.generating'))
      } else if (status === 'success' && result) {
        body = e(Fragment, null,
          e('div', { className: 'sharePageResult' },
            t('dialog.successPath'), e('br', null), e('code', null, result.path)),
          e('div', { className: 'sharePageResult' },
            t('dialog.sessionFingerprint'), e('br', null), e('code', null, result.sessionFingerprint)),
          e('div', { className: 'sharePageResult' },
            t('dialog.fileFingerprint'), e('br', null), e('code', null, result.fileFingerprint)),
          e('div', { className: 'sharePageResult' },
            `${t('dialog.stats')}${result.stats ? `：${result.stats.turns ?? 0} ${t('dialog.turns')} · ${result.stats.toolCalls ?? 0} ${t('dialog.toolCalls')} · ${result.size} B` : ''}${result.redacted ? `（${t('dialog.redacted')}）` : ''}`),
        )
      } else if (status === 'error') {
        body = e('div', { className: 'sharePageResult', style: { color: 'var(--dsw-alias-label-danger, #f85149)' } }, error)
      } else {
        body = e('div', null,
          e('div', { className: 'sharePageField' },
            e('label', { htmlFor: 'share-theme' }, t('option.theme')),
            e('select', { id: 'share-theme', defaultValue: 'auto', 'data-share-opt': 'theme' },
              e('option', { value: 'auto' }, t('theme.auto')),
              e('option', { value: 'light' }, t('theme.light')),
              e('option', { value: 'dark' }, t('theme.dark')))),
          e('div', { className: 'sharePageField' },
            e('label', { htmlFor: 'share-redact' },
              e('input', { id: 'share-redact', type: 'checkbox', defaultChecked: true, 'data-share-opt': 'redact' }),
              ' ' + t('option.redact'))),
          e('div', { className: 'sharePageField' },
            e('label', { htmlFor: 'share-reasoning' },
              e('input', { id: 'share-reasoning', type: 'checkbox', defaultChecked: true, 'data-share-opt': 'reasoning' }),
              ' ' + t('option.reasoning'))),
          e('div', { className: 'sharePageField' },
            e('label', { htmlFor: 'share-watermark' }, t('option.watermark')),
            e('input', { id: 'share-watermark', type: 'text', placeholder: t('option.watermarkPlaceholder'), 'data-share-opt': 'watermark' })),
        )
      }

      const footer = status === 'success'
        ? e(Fragment, null,
            e(ui.Button, { variant: 'primary', onClick: copyPath, children: t('dialog.copyPath') }),
            e(ui.Button, { onClick: () => dismiss(sessionId), children: t('dialog.close') }))
        : status === 'error'
          ? e(ui.Button, { variant: 'primary', onClick: () => dismiss(sessionId), children: t('dialog.close') })
          : e(ui.Button, {
              variant: 'primary',
              disabled: status === 'generating',
              onClick: () => {
                const collect = (el) => {
                  const node = document.getElementById(el)
                  if (!node) return undefined
                  if (node.type === 'checkbox') return node.checked
                  return node.value
                }
                request(sessionId, {
                  theme: collect('share-theme') || 'auto',
                  redact: collect('share-redact') !== false,
                  includeReasoning: collect('share-reasoning') !== false,
                  watermark: collect('share-watermark') || '',
                })
              },
              children: status === 'generating' ? t('dialog.generating') : t('dialog.generate'),
            })

      return e(ui.Modal, {
        open,
        onClose: () => dismiss(sessionId),
        title: status === 'success' ? t('dialog.successTitle') : status === 'error' ? t('dialog.errorTitle') : t('dialog.title'),
        description: status === 'success' ? t('dialog.successDescription') : status === 'error' ? t('dialog.errorDescription') : t('dialog.description'),
        closeLabel: t('dialog.close'),
        footer,
        children: body,
      })
    }

    function ShareHeaderAction(props) {
      const { sessionId, useSessionSharePage, request, t } = props
      const busy = useSessionSharePage((state) => state.bySession[String(sessionId)])?.status === 'generating'
      return e(Fragment, null,
        e('button', {
          type: 'button',
          className: 'sharePageButton',
          disabled: busy,
          'aria-busy': busy,
          title: t('button.tooltip'),
          onClick: () => {
            // 首次点击：打开选项对话框（request 无 options 时即打开）
            request(sessionId)
          },
          children: e('span', null, t('button.label')),
        }),
        e(ShareDialog, { ...props }))
    }

    // -------------------------------------------------------------------------
    // 文案
    // -------------------------------------------------------------------------

    const zh = {
      'button.label': '分享',
      'button.tooltip': '生成只读分享网页',
      'dialog.title': '分享会话',
      'dialog.description': '把当前会话生成一份自包含的只读网页（单文件 HTML，离线可开，默认脱敏）。',
      'dialog.generate': '生成分享页',
      'dialog.generating': '正在生成分享页…',
      'dialog.successTitle': '分享页已生成',
      'dialog.successDescription': '文件已写入磁盘并自动开始下载，可复制路径或直接分享文件。',
      'dialog.errorTitle': '生成失败',
      'dialog.errorDescription': '无法生成分享页。',
      'dialog.failedGeneric': '生成分享页失败。',
      'dialog.copyPath': '复制路径',
      'dialog.close': '关闭',
      'dialog.successPath': '输出路径',
      'dialog.sessionFingerprint': '会话指纹',
      'dialog.fileFingerprint': '文件指纹',
      'dialog.stats': '规模',
      'dialog.turns': '轮',
      'dialog.toolCalls': '次工具调用',
      'dialog.redacted': '已脱敏',
      'option.theme': '默认主题',
      'option.redact': '脱敏（邮箱/密钥/绝对路径/IP）',
      'option.reasoning': '包含思考过程（折叠）',
      'option.watermark': '水印文本（可选）',
      'option.watermarkPlaceholder': '如：内部资料，请勿外传',
      'theme.auto': '跟随系统',
      'theme.light': '浅色',
      'theme.dark': '深色',
    }
    const en = {
      'button.label': 'Share',
      'button.tooltip': 'Generate a read-only share page',
      'dialog.title': 'Share session',
      'dialog.description': 'Render this session as a self-contained read-only webpage (single-file HTML, offline-friendly, redacted by default).',
      'dialog.generate': 'Generate page',
      'dialog.generating': 'Generating…',
      'dialog.successTitle': 'Share page ready',
      'dialog.successDescription': 'The file has been written to disk and the download has started automatically. Copy the path or share the file.',
      'dialog.errorTitle': 'Generation failed',
      'dialog.errorDescription': 'Could not generate the share page.',
      'dialog.failedGeneric': 'Failed to generate the share page.',
      'dialog.copyPath': 'Copy path',
      'dialog.close': 'Close',
      'dialog.successPath': 'Output path',
      'dialog.sessionFingerprint': 'Session fingerprint',
      'dialog.fileFingerprint': 'File fingerprint',
      'dialog.stats': 'Size',
      'dialog.turns': 'turns',
      'dialog.toolCalls': 'tool calls',
      'dialog.redacted': 'redacted',
      'option.theme': 'Default theme',
      'option.redact': 'Redact (emails/secrets/absolute paths/IPs)',
      'option.reasoning': 'Include reasoning (collapsed)',
      'option.watermark': 'Watermark (optional)',
      'option.watermarkPlaceholder': 'e.g. Internal, do not distribute',
      'theme.auto': 'System',
      'theme.light': 'Light',
      'theme.dark': 'Dark',
    }

    // -------------------------------------------------------------------------
    // 插件装配
    // -------------------------------------------------------------------------

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const controller = new SharePageController()
      ctx.provide('sessionSharePage', controller)
      ctx.effect(() => () => {
        controller.dispose()
      }, 'dsh-share-page: browser lifecycle')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-share-page: dictionaries')
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'share-page',
        locale: NS,
        inject: () => ({
          hooks: { sessionSharePage: controller.store },
          request: (sessionId, options) => {
            if (options === void 0) controller.open(sessionId)
            else controller.generate(sessionId, options)
          },
          dismiss: (sessionId) => controller.dismiss(sessionId),
        }),
      }, ShareHeaderAction))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
