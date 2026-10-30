// DSH Web client half. It observes the Session Controller's canonical current
// selection and reports only that opaque session ID over Connection's existing
// authenticated RPC transport. It never receives browser leases or page data.
window.__ModuleLoader__.load({
  id: 'dsh-native-browser',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    async function callHost(ctx, endpoint, payload, signal) {
      // New hosts share authenticated /api routes across Web and Desktop.
      // Retry only a definite missing route, never an auth/timeout/server error.
      try {
        const result = await ctx.connection.rpc.call('/api', `dsh-native-browser/${endpoint}`, payload, signal);
        if (result?.ok !== false || result.error?.code !== 'gateway/not-found') return result;
      } catch (error) {
        if (!String(error?.message).endsWith(': HTTP 404')) throw error;
      }
      signal?.throwIfAborted();
      return ctx.connection.rpc.call('/dsh-native-browser', endpoint, payload, signal);
    }

    function setupSettings(ctx) {
      // Older/custom clients may omit settings. Foreground handoff must still
      // work there; use the host's React, never bundle another React instance.
      if (!ctx.slots?.inject || typeof require !== 'function') return;
      const React = require('react');
      const h = React.createElement;
      const zh = typeof navigator === 'undefined' || navigator.language?.startsWith('zh');
      const t = (cn, en) => zh ? cn : en;
      function Setup() {
        const [status, setStatus] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState('');
        const [error, setError] = React.useState('');
        const active = React.useRef(null);
        const perform = async (endpoint) => {
          if (active.current) return;
          const controller = new AbortController(); active.current = controller;
          setBusy(true); setError(''); setNotice('');
          const timer = setTimeout(() => controller.abort(), 60000);
          try {
            const response = await callHost(ctx, endpoint,
              endpoint === 'setup.install' ? { confirmed: true } : {}, controller.signal);
            if (controller.signal.aborted) return;
            if (response?.ok !== true) throw new Error(response?.error?.message || t('请求失败，请重试。', 'Request failed. Please retry.'));
            if (endpoint === 'setup.status') setStatus(response.value);
            if (endpoint === 'setup.install') {
              setStatus(response.value.status);
              setNotice(response.value.result?.openError
                ? t('本机组件已配置，但未能自动打开 Chrome。请手动打开 chrome://extensions。', 'Components configured. Open chrome://extensions manually.')
                : t('本机组件已配置。请完成下方 Chrome 扩展加载步骤，再检查连接。', 'Components configured. Complete the Chrome steps below, then check the connection.'));
            }
            if (endpoint === 'setup.open') setNotice(t('已打开扩展管理页和扩展文件夹。', 'Opened the extensions page and extension folder.'));
          } catch (e) {
            if (active.current === controller) setError(controller.signal.aborted
              ? t('等待超时，配置可能仍在继续。请点击“检查连接”确认，不要立即重复安装。', 'Timed out. Setup may still be running; check the connection before retrying.')
              : String(e?.message || e));
          } finally {
            clearTimeout(timer);
            if (active.current === controller) { active.current = null; setBusy(false); }
          }
        };
        React.useEffect(() => {
          void perform('setup.status');
          return () => { const running = active.current; active.current = null; running?.abort(); };
        }, []);
        const waiting = busy || status?.installing;
        const button = (label, endpoint, disabled = false) => h('button', {
          type: 'button', disabled: Boolean(waiting || disabled), onClick: () => void perform(endpoint),
          style: { font: 'inherit', padding: '9px 14px', borderRadius: 8, cursor: 'pointer',
            color: 'inherit', background: 'var(--dsw-alias-interactive-bg-hover, transparent)', border: '1px solid #8886' },
        }, label);
        return h('section', { 'aria-label': 'DSH Native Browser', style: { maxWidth: 720, lineHeight: 1.7, padding: '8px 0' } },
          h('h2', null, 'DSH Native Browser'),
          h('p', null, t('在这里完成 Chrome 配置，无需查找 Profile 或复制安装命令。', 'Set up Chrome here without finding a Profile or editing commands.')),
          h('p', null, t('配置将在运行 DSH 的这台 Mac 上注册浏览器组件、启动登录后自动运行的本地服务，并打开 Chrome。不会更改 DSH 的操作审批设置。远程连接的 DSH 不会配置你面前的电脑。',
            'Setup registers browser components and a login service on the Mac running DSH, then opens Chrome. DSH approval settings stay unchanged. A remote DSH host cannot configure the computer in front of you.')),
          status && h('p', { role: 'status' }, status.report?.status === 'ready'
            ? t('Chrome 已连接。授权目标标签页后，就可以回到聊天开始使用。', 'Chrome is connected. Authorize your target tab, then start chatting.')
            : t('尚未就绪：请完成配置、加载扩展，再检查连接。', 'Not ready: complete setup, load the extension, then check the connection.')),
          status?.supported === false && h('p', { role: 'alert' }, t('自动配置目前仅支持 macOS；其他系统请参考安装文档。', 'Automatic setup currently supports macOS only. See the installation guide for other systems.')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            button(t('完成浏览器配置', 'Set up Chrome'), 'setup.install', !status?.supported),
            // A previous request can continue on the Host after this page closes.
            h('button', { type: 'button', disabled: busy, onClick: () => void perform('setup.status'), style: { font: 'inherit', padding: '9px 14px' } }, t('检查连接', 'Check connection')),
            button(t('打开扩展管理页', 'Open extensions'), 'setup.open', !status?.supported || !status?.extensionStaged)),
          waiting && h('p', { role: 'status' }, t('正在处理，请稍候。关闭此页面不会撤销已经开始的配置。', 'Working. Closing this page does not undo setup already started.')),
          notice && h('p', { role: 'status' }, notice),
          error && h('p', { role: 'alert' }, error),
          status?.extensionStaged && h('div', null,
            h('h3', null, t('Chrome 最后一步', 'Final Chrome step')),
            h('ol', null,
              h('li', null, t('打开 Chrome 扩展管理页，开启右上角“开发者模式”。', 'Open Chrome extensions and enable Developer mode.')),
              h('li', null, t('点击“加载已解压的扩展程序”。在选择目录窗口按 ⌘⇧G，粘贴下方目录并选择。', 'Click Load unpacked. Press ⌘⇧G in the folder picker, paste the path below and select it.')),
              h('li', null, t('打开 DSH Native Browser 扩展弹窗，允许目标标签页，然后点击本页“检查连接”。', 'Open the extension popup, allow the target tab, then check the connection here.'))),
            h('input', { 'aria-label': t('扩展目录', 'Extension directory'), readOnly: true, value: status.extensionPath,
              onFocus: e => e.target.select(), style: { boxSizing: 'border-box', width: '100%', padding: 8, font: 'inherit' } }),
            h('button', { type: 'button', onClick: async () => {
              try { await navigator.clipboard.writeText(status.extensionPath); setNotice(t('已复制扩展目录。', 'Extension path copied.')); }
              catch { setError(t('请点击目录文本，按 ⌘C 复制。', 'Select the path and press ⌘C to copy.')); }
            } }, t('复制扩展目录', 'Copy extension path')),
            h('p', null, t('已从此目录加载过？升级后点扩展卡片的“重新加载”即可。', 'Already loaded this directory? After an upgrade, click Reload on the extension card.'))),
          status?.report?.checks && h('details', null, h('summary', null, t('连接诊断', 'Connection diagnostics')),
            h('ul', null, status.report.checks.map(check => h('li', { key: check.id }, `${check.status === 'ok' ? '✓' : '○'} ${check.message}`, check.hint && h('p', null, check.hint))))),
          h('p', null, t('连接成功后可以说：列出 Chrome 标签页，打开一个普通网页，读取标题并截图。', 'Once connected, ask: List Chrome tabs, open a public webpage, read its title and take a screenshot.')));
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-native-browser', order: 45,
        label: t('浏览器配置', 'Browser setup'),
      }, Setup));
    }

    function pageState() {
      const key = '__DSH_NATIVE_BROWSER_FOREGROUND_V1__';
      const existing = window[key];
      if (existing && typeof existing.clientId === 'string' && Number.isSafeInteger(existing.revision)) return existing;
      const value = { clientId: crypto.randomUUID(), revision: 0, hasLast: false, lastSessionId: null, chain: Promise.resolve() };
      Object.defineProperty(window, key, { value, configurable: true });
      return value;
    }

    function apply(ctx) {
      setupSettings(ctx);
      const state = pageState();
      let disposed = false;
      const lifecycle = new AbortController();
      const publish = (force = false) => {
        if (disposed || document.visibilityState !== 'visible') return;
        const raw = ctx.sessions.list.getSnapshot().current;
        const sessionId = typeof raw === 'string' && raw.length > 0 ? raw : null;
        if (!force && state.hasLast && state.lastSessionId === sessionId) return;
        state.hasLast = true; state.lastSessionId = sessionId;
        const payload = { clientId: state.clientId, revision: ++state.revision, issuedAt: Date.now(), sessionId };
        // Preserve selection order within this page. Host timestamps fence a
        // delayed older page when more than one visible DSH window exists.
        state.chain = Promise.resolve(state.chain).catch(() => {}).then(async () => {
          if (disposed) return;
          const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined;
          const signal = timeout && typeof AbortSignal.any === 'function'
            ? AbortSignal.any([lifecycle.signal, timeout]) : lifecycle.signal;
          const result = await callHost(ctx, 'foreground', payload, signal);
          if (!result || result.ok !== true) throw new Error('Foreground conversation handoff was rejected');
        }).catch(() => {});
      };
      const stopList = ctx.sessions.list.subscribe(() => publish());
      const stopReset = ctx.on('connection/reset', () => publish(true));
      const visible = () => { if (document.visibilityState === 'visible') publish(true); };
      document.addEventListener('visibilitychange', visible);
      publish(true);
      ctx.effect(() => () => {
        disposed = true; lifecycle.abort(); stopList(); stopReset(); document.removeEventListener('visibilitychange', visible);
      }, 'dsh-native-browser: foreground conversation handoff');
    }

    exports.apply = apply;
    exports.inject = ['sessions', 'connection', 'slots'];
    return module.exports;
  },
});
