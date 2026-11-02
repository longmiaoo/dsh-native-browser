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
      const labels = { list: '查找浏览器', claim: '接管页面', open: '打开页面', activate: '显示页面',
        observe: '读取页面', read_page: '继续读取', frames: '检查框架', act: '操作页面', batch: '执行步骤',
        close: '关闭任务页', handoff: '交还控制', release_all: '释放控制', task: '任务收尾' };
      function ToolView(props) {
        const short = props.toolName?.replace(/^native_browser_/, '') || 'task';
        const done = props.phase === 'result', failed = done && props.block?.isError;
        const [elapsed, setElapsed] = React.useState(0);
        React.useEffect(() => {
          if (done) return;
          const start = Date.now(), timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
          return () => clearInterval(timer);
        }, [done, props.callId]);
        let summary = '';
        if (done && !failed) {
          try {
            const content = props.block?.content?.find(c => c.type === 'text')?.text;
            const value = JSON.parse(content || '{}');
            if (typeof value.closed === 'number') summary = t(`关闭 ${value.closed} 页，保留 ${value.retained} 页，待处理 ${value.skipped} 页`,
              `Closed ${value.closed}, retained ${value.retained}, skipped ${value.skipped}`);
            else if (value.outcome === 'unknown' || value.postcondition === 'unverified') summary = t('结果尚未验证，请先观察页面，勿重复提交。', 'Result unverified; observe before retrying.');
            else if (value.outcome === 'failed' || value.outcome === 'cancelled') summary = t('动作未成功完成，请检查详情。', 'Action did not complete successfully; inspect details.');
          } catch { /* Unknown historical output remains available through Inspect. */ }
        }
        return h('section', { 'aria-label': 'DSH Native Browser action', style: { border: '1px solid #8885', borderRadius: 8, padding: 10, margin: '5px 0' } },
          h('strong', null, `DSH Native Browser · ${zh ? labels[short] || short : short}`),
          h('p', { role: 'status' }, failed ? t('操作已停止或失败，请检查详情。', 'Stopped or failed; inspect details.')
            : done ? summary || t('调用已返回', 'Call returned') : `${props.phase === 'preparing' ? t('准备中', 'Preparing') : t('执行中', 'Running')} · ${elapsed}s`),
          props.inspect && h('button', { type: 'button', onClick: () => props.inspect() }, t('查看详情', 'Inspect')));
      }
      // Optional host slot: keep image tools on the host's image-capable fallback.
      ctx.slots.inject('tool.call.toolview', () => {
        const disposers = Object.keys(labels).map(short => ctx.slots.register({ name: 'tool.call.toolview', key: `native_browser_${short}` }, ToolView));
        return () => { for (const dispose of disposers) dispose?.(); };
      });
      function TaskPanel() {
        const [snapshot, setSnapshot] = React.useState(null), [notice, setNotice] = React.useState('');
        const [selection, setSelection] = React.useState(() => ctx.sessions.list.getSnapshot().current);
        React.useEffect(() => ctx.sessions.list.subscribe(() => setSelection(ctx.sessions.list.getSnapshot().current)), []);
        React.useEffect(() => {
          if (typeof selection !== 'string') { setSnapshot(null); return; }
          const controller = new AbortController(); let pending = false;
          const refresh = async () => {
            if (pending || document.visibilityState !== 'visible') return;
            pending = true;
            try {
              const result = await callHost(ctx, 'task.status', { sessionId: selection }, AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]));
              if (!controller.signal.aborted && result?.ok && typeof result.value?.phase === 'string'
                && Array.isArray(result.value.pages)) setSnapshot({ id: selection, value: result.value });
            } catch { /* A missing route on older installed hosts is not a browser failure. */ }
            finally { pending = false; }
          };
          void refresh(); const timer = setInterval(refresh, 1500);
          return () => { controller.abort(); clearInterval(timer); };
        }, [selection]);
        const control = async endpoint => {
          setNotice('');
          try {
            const response = await callHost(ctx, endpoint, { sessionId: selection }, AbortSignal.timeout(18000));
            if (!response?.ok) throw Error(response?.error?.message || 'Request failed');
            const result = response.value;
            if (endpoint === 'task.finish') setNotice(t(`收尾返回：关闭 ${result.closed ?? 0} 页；失效或失败的页面不会强行关闭。`, `Cleanup returned: ${result.closed ?? 0} closed; unavailable pages stay open.`));
          } catch (error) { setNotice(String(error?.message || error)); }
        };
        // Before Desktop hydrates its current conversation, both the optional
        // snapshot id and selection can be undefined. Equality is not evidence
        // that a snapshot exists; keep browser setup usable without a chat.
        const value = snapshot && typeof selection === 'string' && snapshot.id === selection ? snapshot.value : null;
        if (!value || value.phase === 'idle') return null;
        const phases = { running: '执行中', ready: '等待下一步', finishing: '收尾中', completed: '已完成收尾', 'handed-off': '已交接', attention: '需要检查' };
        return h('section', { 'aria-label': 'Browser task status' }, h('h3', null, t('当前对话的浏览器任务', 'Current conversation browser task')),
          h('p', { role: 'status' }, `${zh ? phases[value.phase] || value.phase : value.phase} · ${value.action || ''} · ${value.pages.length} ${t('个任务页', 'task pages')}`),
          value.error && h('p', null, `${t('诊断代码：', 'Diagnostic code: ')}${value.error}`),
          h('button', { type: 'button', onClick: () => void control('task.stop') }, t('停止并交还控制', 'Stop and hand off')),
          h('button', { type: 'button', disabled: value.pending > 0 || value.phase === 'finishing', onClick: () => void control('task.finish') }, t('完成并清理临时页', 'Finish and clean temporary tabs')),
          notice && h('p', { role: 'status' }, notice));
      }
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
        const accessMode = status?.policy?.browserAccessMode;
        const approvalMode = status?.policy?.approvalMode;
        const connected = status?.report?.status === 'ready';
        const modeMismatch = accessMode === 'restricted' && approvalMode === 'personal';
        const connectedText = accessMode === 'personal'
          ? t('Chrome 已连接。个人模式无需逐页授权，可以回到聊天开始使用。', 'Chrome is connected. Personal mode needs no per-tab consent; start chatting.')
          : accessMode === 'restricted'
            ? t('Chrome 已连接，当前为受限模式。请在扩展弹窗中允许目标标签页。', 'Chrome is connected in restricted mode. Allow the target tab in the extension popup.')
            : t('Chrome 已连接。尚未确认页面访问模式，请重新检查连接。', 'Chrome is connected. Check the connection again to confirm its access mode.');
        const button = (label, endpoint, disabled = false) => h('button', {
          type: 'button', disabled: Boolean(waiting || disabled), onClick: () => void perform(endpoint),
          style: { font: 'inherit', padding: '9px 14px', borderRadius: 8, cursor: 'pointer',
            color: 'inherit', background: 'var(--dsw-alias-interactive-bg-hover, transparent)', border: '1px solid #8886' },
        }, label);
        return h('section', { 'aria-label': 'DSH Native Browser', style: { maxWidth: 720, lineHeight: 1.7, padding: '8px 0' } },
          h('h2', null, 'DSH Native Browser'),
          h(TaskPanel),
          h('p', null, t('在这里完成 Chrome 配置，无需查找 Profile 或复制安装命令。', 'Set up Chrome here without finding a Profile or editing commands.')),
          h('p', null, t('配置将在运行 DSH 的这台 Mac 上注册浏览器组件、启动登录后自动运行的本地服务，并打开 Chrome。不会更改 DSH 的操作审批设置。远程连接的 DSH 不会配置你面前的电脑。',
            'Setup registers browser components and a login service on the Mac running DSH, then opens Chrome. DSH approval settings stay unchanged. A remote DSH host cannot configure the computer in front of you.')),
          h('p', null, t('标准安装使用个人浏览器模式：助手可接管此 Chrome 中的普通网页，无需逐页授权。Stop、交还控制和切换对话仍会释放控制。',
            'Standard setup uses personal browser mode: the assistant can claim ordinary tabs in this Chrome without per-tab consent. Stop, handoff and conversation switching still release control.')),
          status && h('p', { role: 'status' }, status.report?.status === 'ready'
            ? connectedText
            : t('尚未就绪：请完成配置、加载扩展，再检查连接。', 'Not ready: complete setup, load the extension, then check the connection.')),
          approvalMode && h('p', null, t('插件审批：', 'Plugin approval: ') + ({
            personal: t('个人模式，不额外逐次询问；仍遵循 DSH 的权限设置。', 'Personal mode, no extra per-action prompts; DSH permissions still apply.'),
            'per-action': t('逐次审批。当前显式配置会在操作时请求确认。', 'Per action. Your explicit configuration requests confirmation for actions.'),
            'per-lease': t('每次接管时确认，同一次接管中的后续动作不额外询问。', 'Confirm each claim; no extra prompts for subsequent actions under that lease.'),
            trusted: t('仅信任已配置的网站来源。', 'Only the configured website origins are trusted.'),
          }[approvalMode] || approvalMode)),
          modeMismatch && h('p', { role: 'alert' }, t('插件为个人模式，但后台为受限模式。请点击“完成浏览器配置”启用匹配的个人后台，或显式选择受限审批配置。',
            'The plugin uses personal mode but the Broker is restricted. Run Set up Chrome for a matching personal Broker, or explicitly configure restricted approvals.')),
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
            h('h3', null, connected ? t('扩展已连接', 'Extension connected') : t('Chrome 最后一步', 'Final Chrome step')),
            !connected && h('ol', null,
              h('li', null, t('打开 Chrome 扩展管理页，开启右上角“开发者模式”。', 'Open Chrome extensions and enable Developer mode.')),
              h('li', null, t('点击“加载已解压的扩展程序”。在选择目录窗口按 ⌘⇧G，粘贴下方目录并选择。', 'Click Load unpacked. Press ⌘⇧G in the folder picker, paste the path below and select it.')),
              h('li', null, accessMode === 'restricted'
                ? t('在扩展弹窗中允许目标标签页，然后点击“检查连接”。', 'Allow the target tab in the extension popup, then check the connection.')
                : t('加载扩展后回到此页点击“检查连接”；个人模式无需逐页授权。', 'After loading the extension, check the connection here; personal mode needs no per-tab consent.'))),
            !connected && h('p', null, t('找不到目录？它在 macOS 的隐藏文件夹中。在 Chrome 选择目录的窗口同时按 Command + Shift + G，再粘贴目录并回车；选择整个 chrome 文件夹，不是里面的文件。',
              'Cannot find it? The folder is hidden on macOS. In Chrome’s folder picker, press Command + Shift + G, paste the path and press Return. Select the whole chrome folder, not a file inside it.')),
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
      const isForeground = () => document.visibilityState === 'visible'
        && (typeof document.hasFocus !== 'function' || document.hasFocus());
      const publish = (force = false) => {
        if (disposed || !isForeground()) return;
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
      window.addEventListener('focus', visible);
      publish(true);
      ctx.effect(() => () => {
        disposed = true; lifecycle.abort(); stopList(); stopReset(); document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('focus', visible);
      }, 'dsh-native-browser: foreground conversation handoff');
    }

    exports.apply = apply;
    exports.inject = ['sessions', 'connection', 'slots'];
    return module.exports;
  },
});
