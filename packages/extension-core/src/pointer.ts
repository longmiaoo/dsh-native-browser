type PointerPhase = 'move' | 'click' | 'wheel';
type PointerMessage = Readonly<{ type: 'dsh.pointer.v1'; action: 'show'; x: number; y: number; phase: PointerPhase }>
  | Readonly<{ type: 'dsh.pointer.v1'; action: 'remove' }>;
type PointerState = { host: HTMLDivElement; arrow: SVGElement; ring: HTMLDivElement; fade?: ReturnType<typeof setTimeout> };
const world = globalThis as typeof globalThis & { __dshPointerV1?: PointerState; __dshPointerListenerV1?: true };

function remove(): void {
  if (world.__dshPointerV1?.fade) clearTimeout(world.__dshPointerV1.fade);
  world.__dshPointerV1?.host.remove(); delete world.__dshPointerV1;
}

function show(payload: Extract<PointerMessage, { action: 'show' }>): void {
  if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y) || payload.x < 0 || payload.y < 0
    || !['move', 'click', 'wheel'].includes(payload.phase)) return;
  let state = world.__dshPointerV1;
  if (!state?.host.isConnected) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true'); host.setAttribute('inert', ''); host.dataset.dshPointer = 'v1';
    Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '96px', height: '80px', overflow: 'visible',
      zIndex: '2147483647', pointerEvents: 'none', userSelect: 'none', isolation: 'isolate',
      opacity: '0', transition: 'opacity 120ms ease' });
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial}.arrow{position:absolute;left:18px;top:18px;width:32px;height:40px;overflow:visible;
        filter:drop-shadow(0 2px 3px rgba(0,0,0,.58));transform-origin:4px 4px}
      .badge{position:absolute;left:45px;top:44px;padding:2px 6px;border-radius:9px;background:#126fe8;color:#fff;
        font:700 10px/14px system-ui,-apple-system,sans-serif;letter-spacing:.3px;box-shadow:0 1px 3px rgba(0,0,0,.35)}
      .ring{position:absolute;left:2px;top:2px;width:36px;height:36px;border:4px solid #37a6ff;border-radius:999px;
        box-sizing:border-box;opacity:0;transform:scale(.35)}
      .ring.click{animation:dsh-click 420ms cubic-bezier(.2,.8,.2,1)}
      .ring.wheel{border-style:dashed;animation:dsh-wheel 520ms ease-out}
      @keyframes dsh-click{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.55)}}
      @keyframes dsh-wheel{0%{opacity:.9;transform:scale(.45) rotate(0)}100%{opacity:0;transform:scale(1.3) rotate(90deg)}}
    </style><svg class="arrow" viewBox="0 0 25 31" aria-hidden="true">
      <path d="M2 1.5v23.2l6.3-5.6 4.1 9.6 4.1-1.8-4.2-9.4 8.5-.4z" fill="#1687ff" stroke="white" stroke-width="2.2" stroke-linejoin="round"/>
    </svg><div class="badge">DSH</div><div class="ring"></div>`;
    const arrow = root.querySelector('.arrow') as SVGElement, ring = root.querySelector('.ring') as HTMLDivElement;
    (document.documentElement || document.body)?.append(host);
    state = world.__dshPointerV1 = { host, arrow, ring };
  }
  const { host, arrow, ring } = state;
  host.style.transition = host.style.opacity === '0' ? 'opacity 120ms ease' : 'transform 110ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease';
  host.style.transform = `translate3d(${payload.x - 20}px,${payload.y - 20}px,0)`; host.style.opacity = '1';
  arrow.style.transform = payload.phase === 'move' ? 'scale(.94)' : 'scale(1)';
  if (payload.phase !== 'move') { ring.className = 'ring'; void ring.getBoundingClientRect(); ring.classList.add(payload.phase); }
  if (state.fade) clearTimeout(state.fade);
  state.fade = setTimeout(() => { if (host.isConnected) host.style.opacity = '.78'; }, 8000);
}

if (!world.__dshPointerListenerV1) {
  world.__dshPointerListenerV1 = true;
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as Partial<PointerMessage>;
    if (message.type !== 'dsh.pointer.v1') return;
    if (message.action === 'remove') remove();
    else if (message.action === 'show') show(message as Extract<PointerMessage, { action: 'show' }>);
    return true;
  });
}
