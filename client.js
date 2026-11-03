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

    function selectedSession(ctx) {
      const snapshot = ctx.sessions.list.getSnapshot();
      if (snapshot?.byId && typeof snapshot.byId === 'object') {
        // Current Session Controller exposes catalog + local retention, not a
        // `current` field. Follow the Host layout's mainView ownership only;
        // sidebar/cache retention is not a selected conversation.
        const selected = Object.values(snapshot.byId).filter(row => typeof row?.id === 'string'
          && row.id.length > 0 && row.retainedBy?.mainView > 0);
        if (selected.length === 1) return selected[0].id;
        if (selected.length > 1 || snapshot.phase === 'pending') return undefined;
        return null;
      }
      // Compatibility with older hosts that explicitly publish selection.
      if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'current')) {
        const id = snapshot.current;
        return typeof id === 'string' && id.length > 0 ? id : id === null ? null : undefined;
      }
      return undefined; // Unknown API shape is not evidence of deselection.
    }

    function setupSettings(ctx) {
      // Older/custom clients may omit settings. Foreground handoff must still
      // work there; use the host's React, never bundle another React instance.
      if (!ctx.slots?.inject || typeof require !== 'function') return;
      const React = require('react');
      const h = React.createElement;
      const zh = typeof navigator === 'undefined' || navigator.language?.startsWith('zh');
      const t = (cn, en) => zh ? cn : en;
      const panelId = 'dsh-native-browser.setup';
      const getLayout = () => typeof ctx.get === 'function' ? ctx.get('layout') : ctx.layout;
      const testPrompt = t('使用 native_browser 工具，读取当前 Chrome 网页的标题和主要内容，然后交还浏览器控制。',
        'Use native_browser tools to read the title and main content of my current Chrome page, then hand control back to me.');
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
        const [selection, setSelection] = React.useState(() => selectedSession(ctx));
        React.useEffect(() => ctx.sessions.list.subscribe(() => setSelection(selectedSession(ctx))), []);
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
          value.attention && h('p', { role: 'alert' }, ({
            'verify-result': t('操作结果尚需核实。请先检查页面或业务记录，勿重复提交；普通页面读取不代表此前操作已成功。', 'Verify the page or application records before resubmitting. A successful page read does not verify an earlier action.'),
            'check-connection': t('请在浏览器配置中检查连接与版本。重连不会恢复原控制权；继续前先核对页面结果。', 'Check the connection and versions in Browser setup. Reconnecting does not restore control; verify the page before continuing.'),
            'wait-control': t('控制已中断或页面正被占用。请先确认当前对话和用户是否已接手，勿自动抢回或重放操作。', 'Control was interrupted or is busy. Check the selected conversation and human handoff; do not automatically reclaim or replay input.'),
            'refresh-target': t('页面或目标可能已变化。重新观察并明确目标，勿沿用旧引用或重复旧点击。', 'Observe again and identify the target; do not reuse stale references or repeat old clicks.'),
            'respect-policy': t('请核对显式权限与已支持能力。被拒绝的操作不能通过其他工具绕过。', 'Check explicit permissions and supported capabilities. Do not bypass a denied operation through another tool.'),
          }[value.attention] || t('请检查当前页面与工具结果后再继续。', 'Check the page and tool result before continuing.'))),
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
          const refresh = () => { if (document.visibilityState === 'visible' && !active.current) void perform('setup.status'); };
          void perform('setup.status');
          window.addEventListener('focus', refresh);
          return () => { window.removeEventListener('focus', refresh); const running = active.current; active.current = null; running?.abort(); };
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
            color: endpoint === 'setup.install' ? '#fff' : 'inherit', background: endpoint === 'setup.install' ? '#126fe8' : 'var(--dsw-alias-interactive-bg-hover, transparent)', border: '1px solid #8886' },
        }, label);
        return h('section', { 'aria-label': 'DSH Native Browser', style: { maxWidth: 720, lineHeight: 1.7, padding: '8px 0' } },
          h('h2', null, 'DSH Native Browser'),
          h('p', { style: { fontSize: 17, fontWeight: 600 } }, t('插件已安装。再连接一次 Chrome，就可以直接在聊天中使用。', 'Plugin installed. Connect Chrome once, then use it from chat.')),
          h('ol', { 'aria-label': t('Chrome 配置进度', 'Chrome setup progress'), style: { paddingLeft: 24, borderLeft: '3px solid #1687ff', lineHeight: 2 } },
            h('li', null, t('安装 DSH 插件 ✓', 'Install the DSH plugin ✓')),
            h('li', null, status?.extensionStaged ? t('配置本机 Chrome ✓', 'Set up local Chrome ✓') : t('点击下方“完成浏览器配置”', 'Click Set up Chrome below')),
            h('li', null, connected ? t('Chrome 已连接 ✓ 可以开始对话', 'Chrome connected ✓ Start chatting') : t('在 Chrome 加载扩展，回来点“检查连接”', 'Load the extension in Chrome, then Check connection'))),
          h('p', null, t('点击配置后会自动打开 Chrome 扩展管理页和扩展文件夹，无需终端命令或 Profile 名称。', 'Setup opens Chrome extensions and its folder automatically. No terminal commands or Profile name needed.')),
          h('details', null, h('summary', null, t('配置会做什么？', 'What does setup do?')),
            h('p', null, t('在运行 DSH 的 Mac 上配置 Chrome 连接，并启动登录后自动运行的本地服务。个人模式允许助手接管此 Chrome 的普通网页，无需逐页授权；DSH 自身权限、Stop 和交还控制仍生效。',
              'Connects Chrome on the Mac running DSH and starts a login service. Personal mode allows ordinary tabs without per-tab consent; DSH permissions, Stop and handoff still apply.')),
            h('p', null, t('如果远程连接了另一台机器上的 DSH，这里配置的是那台主机，不能配置你面前的电脑。', 'If DSH runs on a remote machine, setup affects that host, not the computer in front of you.'))),
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
          status?.extensionStaged && h(connected ? 'details' : 'div', null,
            connected ? h('summary', null, t('升级或重新加载 Chrome 扩展', 'Update or reload the Chrome extension'))
              : h('h3', null, t('Chrome 最后一步', 'Final Chrome step')),
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
          h('section', { 'aria-label': t('第一次使用', 'First browser task') },
            h('h3', null, t('连接后，复制这句话到 DSH 聊天', 'Once connected, paste this into DSH chat')),
            h('p', null, t('先在 Chrome 打开一个普通网页，然后回到 DSH 对话。', 'Open an ordinary webpage in Chrome, then return to DSH chat.')),
            h('blockquote', { style: { margin: '12px 0', padding: 12, borderLeft: '3px solid #1687ff', background: '#1687ff15' } }, testPrompt),
            h('button', { type: 'button', onClick: async () => {
              try { await navigator.clipboard.writeText(testPrompt); setNotice(t('试用指令已复制，回到 DSH 聊天粘贴即可。', 'Copied. Paste the prompt into DSH chat.')); }
              catch { setError(t('请选中上方试用指令并复制。', 'Select and copy the prompt above.')); }
            } }, t('复制试用指令', 'Copy first-task prompt'))),
          h(TaskPanel));
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-native-browser', order: 45,
        label: t('浏览器配置', 'Browser setup'),
      }, Setup));
      // Current DSH declares these slots on the Plugins page. Older clients
      // simply omit them and retain the settings entry above.
      function PluginSetup(props) {
        return props.view === 'summary'
          ? h('p', null, t('安装后在这里连接 Chrome，再回到聊天开始使用。', 'Connect Chrome here after installation, then start from chat.'))
          : h(Setup);
      }
      for (const [slot, key] of [['plugins.bundle.config', 'dsh-native-browser'], ['plugins.row.config', 'dsh-native-browser#native-browser']]) {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key }, PluginSetup));
      }
      function Welcome(props) {
        if (props.packageName !== 'dsh-native-browser') return null;
        return h('section', { 'aria-label': 'DSH Native Browser welcome', style: { border: '1px solid #1687ff80', borderRadius: 12, padding: 18, margin: '12px 0', lineHeight: 1.7 } },
          h('h3', null, t('已启用：下一步连接 Chrome', 'Enabled: connect Chrome next')),
          h('p', null, t('打开插件详情中的配置向导，一次完成 Chrome 连接。连接成功后直接在聊天中提问。', 'Open the setup guide in plugin details to connect Chrome, then ask for browser tasks in chat.')),
          h('button', { type: 'button', onClick: () => props.onOpenDetails?.() }, t('现在连接 Chrome', 'Connect Chrome now')),
          props.onDismiss && h('button', { type: 'button', onClick: () => props.onDismiss() }, t('稍后设置', 'Set up later')));
      }
      ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: 'dsh-native-browser' }, Welcome));
      function BrowserIcon() {
        return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }), h('path', { d: 'M3 9h18M7 6.5h.01M10 6.5h.01M11 12l5 3-3 1-1 3z' }));
      }
      // Slot declarations arrive while Layout's provider fiber is still loading;
      // Cordis ctx.get() intentionally hides it until activation. Register from
      // the declaration alone and resolve navigation only when the user clicks.
      ctx.slots.inject('main', () => {
        const disposeMain = ctx.slots.register({ name: 'main', key: panelId }, () => h('main', {
          style: { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: 'max(24px, var(--dsh-frame-top-clearance, 24px)) 24px 32px' },
        }, h('div', { style: { maxWidth: 760, margin: '0 auto' } },
          h('button', { type: 'button', onClick: () => getLayout()?.selectPanel(null) }, t('返回对话', 'Back to chat')), h(Setup))));
        const disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId,
          order: 20, label: t('浏览器', 'Browser') }, BrowserIcon));
        return () => { if (typeof disposeSidebar === 'function') disposeSidebar(); disposeMain?.(); };
      });
      function DetailAction({ subject }) {
        if (!['bundle', 'row'].includes(subject?.kind) || subject.pkg?.name !== 'dsh-native-browser'
          || typeof getLayout()?.selectPanel !== 'function') return null;
        return h('button', { type: 'button', onClick: () => getLayout()?.selectPanel(panelId) }, t('配置浏览器', 'Set up browser'));
      }
      ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: 'dsh-native-browser.setup' }, DetailAction));
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
        const sessionId = selectedSession(ctx);
        if (sessionId === undefined) return;
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
        }).catch(() => {
          // A failed notification was not a synchronized selection. Permit the
          // next store notification to retry instead of caching false success.
          if (!disposed && state.revision === payload.revision) state.hasLast = false;
        });
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
