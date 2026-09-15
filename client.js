// DSH Web client half. It observes the Session Controller's canonical current
// selection and reports only that opaque session ID over Connection's existing
// authenticated RPC transport. It never receives browser leases or page data.
window.__ModuleLoader__.load({
  id: 'dsh-native-browser',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    function pageState() {
      const key = '__DSH_NATIVE_BROWSER_FOREGROUND_V1__';
      const existing = window[key];
      if (existing && typeof existing.clientId === 'string' && Number.isSafeInteger(existing.revision)) return existing;
      const value = { clientId: crypto.randomUUID(), revision: 0, hasLast: false, lastSessionId: null, chain: Promise.resolve() };
      Object.defineProperty(window, key, { value, configurable: true });
      return value;
    }

    function apply(ctx) {
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
          const result = await ctx.connection.rpc.call('/dsh-native-browser', 'foreground', payload, signal);
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
    exports.inject = ['sessions', 'connection'];
    return module.exports;
  },
});
