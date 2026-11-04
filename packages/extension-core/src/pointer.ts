import { activityLabels, feedbackType, type Activity, type Feedback, type PointerPhase } from './feedback.js';

type Point = { x: number; y: number };
type Pointer = { host: HTMLDivElement; arrow: SVGElement; ring: HTMLDivElement; badge: HTMLDivElement };
type State = {
  floor: number; pointerRevision: number; activityRevision: number;
  pointer?: Pointer; activity?: { host: HTMLDivElement; label: HTMLSpanElement };
  point?: Point; target?: Point; phase?: PointerPhase; frame?: number;
  expiry?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; busyAt?: number;
};
const world = globalThis as typeof globalThis & { __dshFeedbackV2?: State; __dshFeedbackListenerV2?: true };
const state = world.__dshFeedbackV2 ??= { floor: 0, pointerRevision: 0, activityRevision: 0 };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function shell(attribute: string): { host: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true'); host.setAttribute('inert', ''); host.setAttribute(attribute, 'v1');
  // Important prevents ordinary page CSS from moving or blocking the overlay.
  for (const [key, value] of Object.entries({ position: 'fixed', margin: '0', padding: '0', border: '0',
    'z-index': '2147483647', 'pointer-events': 'none', 'user-select': 'none' })) host.style.setProperty(key, value, 'important');
  const root = host.attachShadow({ mode: 'closed' });
  (document.documentElement || document.body)?.append(host);
  return { host, root };
}
function style(root: ShadowRoot, text: string): void {
  const css = document.createElement('style'); css.textContent = text; root.append(css);
}
function removePointer(): void {
  if (state.frame !== undefined) cancelAnimationFrame(state.frame);
  delete state.frame; state.pointer?.host.remove(); delete state.pointer;
  delete state.point; delete state.target; delete state.phase;
}
function remove(): void {
  removePointer(); state.activity?.host.remove(); delete state.activity;
  clearTimeout(state.expiry); clearTimeout(state.idle); delete state.expiry; delete state.idle;
}
function activity(phase: Activity): void {
  if (!state.activity?.host.isConnected) {
    const { host, root } = shell('data-dsh-activity');
    host.style.setProperty('top', '12px', 'important'); host.style.setProperty('right', '12px', 'important');
    style(root, `:host{all:initial}.panel{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid #ffffff55;
      border-radius:20px;background:#102842ed;color:white;box-shadow:0 2px 10px #0003;font:600 12px/18px system-ui,sans-serif}
      .dot{width:8px;height:8px;border-radius:50%;background:#59b9ff;animation:pulse 1.4s ease-in-out infinite}
      @keyframes pulse{50%{opacity:.35}}:host([data-phase=waiting]) .dot{animation:none;background:#8bb3cf}
      @media(prefers-reduced-motion:reduce){.dot{animation:none}}`);
    const panel = document.createElement('div'); panel.className = 'panel';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); panel.append(dot, label); root.append(panel);
    state.activity = { host, label };
  }
  state.activity.host.dataset.phase = phase;
  state.activity.label.textContent = `DSH · ${activityLabels[phase]}`;
}
function pointer(): Pointer {
  if (!state.pointer?.host.isConnected) {
    const { host, root } = shell('data-dsh-pointer');
    host.style.setProperty('top', '0', 'important'); host.style.setProperty('left', '0', 'important');
    host.style.setProperty('width', '90px', 'important'); host.style.setProperty('height', '64px', 'important');
    host.style.setProperty('overflow', 'visible', 'important');
    style(root, `:host{all:initial}.arrow{position:absolute;left:0;top:0;width:30px;height:38px;overflow:visible;
      filter:drop-shadow(0 2px 3px #0008);transform-origin:2px 2px}
      .badge{position:absolute;left:24px;top:28px;padding:2px 6px;border-radius:9px;background:#126fe8;color:white;
        font:700 10px/14px system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 3px #0005}
      .ring{position:absolute;left:-16px;top:-16px;width:36px;height:36px;border:3px solid #37a6ff;
        border-radius:50%;box-sizing:border-box;opacity:0}
      .ring.click{animation:click 420ms ease-out}.ring.wheel{border-style:dashed;animation:wheel 600ms ease-out}
      .ring.typing{animation:typing 800ms ease-out}
      @keyframes click{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.6)}}
      @keyframes wheel{0%{opacity:.9;transform:scale(.45) rotate(0)}100%{opacity:0;transform:scale(1.3) rotate(90deg)}}
      @keyframes typing{0%{opacity:.8;transform:scale(.6)}100%{opacity:0;transform:scale(1.2)}}
      @media(prefers-reduced-motion:reduce){.ring{animation:none!important}}`);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'arrow'); arrow.setAttribute('viewBox', '0 0 25 31');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: 'M2 1.5v23.2l6.3-5.6 4.1 9.6 4.1-1.8-4.2-9.4 8.5-.4z',
      fill: '#1687ff', stroke: 'white', 'stroke-width': '2.2', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
    arrow.append(path);
    const badge = document.createElement('div'); badge.className = 'badge';
    const ring = document.createElement('div'); ring.className = 'ring'; root.append(arrow, badge, ring);
    state.pointer = { host, arrow, badge, ring };
  }
  return state.pointer;
}
function paint(point: Point): void {
  state.point = point;
  pointer().host.style.setProperty('transform', `translate3d(${point.x - 2}px,${point.y - 2}px,0)`, 'important');
}
function pulse(): void {
  const p = state.pointer;
  if (!p || !state.phase) return;
  p.ring.className = 'ring';
  if (state.phase !== 'move') { void p.ring.getBoundingClientRect(); p.ring.classList.add(state.phase); }
  p.host.dataset.moving = 'false';
}
function show(x: number, y: number, phase: PointerPhase): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > innerWidth || y > innerHeight
    || !['move', 'click', 'wheel', 'typing'].includes(phase)) return;
  const p = pointer(); state.phase = phase;
  p.badge.textContent = phase === 'typing' ? 'DSH 输入' : phase === 'wheel' ? 'DSH 滚动' : 'DSH';
  p.host.dataset.phase = phase;
  const target = { x, y };
  // Press/release at the same point updates feedback without restarting motion.
  if (state.frame !== undefined && state.target?.x === x && state.target?.y === y) return;
  if (state.frame !== undefined) cancelAnimationFrame(state.frame);
  delete state.frame; state.target = target;
  const from = state.point;
  if (!from || reduced() || document.visibilityState === 'hidden') { paint(target); pulse(); return; }
  const distance = Math.hypot(x - from.x, y - from.y);
  if (distance < 1) { paint(target); pulse(); return; }
  const duration = Math.min(420, Math.max(160, distance / 1.8)), start = performance.now();
  p.host.dataset.moving = 'true';
  const tick = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    const eased = 1 - (1 - t) ** 3;
    paint({ x: from.x + (x - from.x) * eased, y: from.y + (y - from.y) * eased });
    if (t < 1 && !reduced()) state.frame = requestAnimationFrame(tick);
    else { delete state.frame; paint(target); pulse(); }
  };
  state.frame = requestAnimationFrame(tick);
}
function showFocus(): void {
  let target = document.activeElement;
  while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  if (!target || target === document.body || target === document.documentElement || target.tagName === 'IFRAME') return;
  const rect = target.getBoundingClientRect();
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  if (right > left && bottom > top) show((left + right) / 2, (top + bottom) / 2, 'typing');
}
function receive(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const m = raw as Feedback;
  if (m.type !== feedbackType || !Number.isSafeInteger(m.revision) || m.revision <= state.floor) return;
  if (m.action === 'remove') {
    state.floor = m.revision;
    // A delayed old Stop must not erase a newer lease's visible feedback.
    if (m.revision >= Math.max(state.pointerRevision, state.activityRevision)) remove();
    return;
  }
  if (!Number.isSafeInteger(m.expiresAt) || m.expiresAt <= Date.now() || m.expiresAt > Date.now() + 10 * 60_000) return;
  if (m.action === 'activity') {
    if (m.revision < state.activityRevision || !Object.hasOwn(activityLabels, m.phase)) return;
    state.activityRevision = m.revision; clearTimeout(state.idle);
    if (m.resetPointer) { state.pointerRevision = Math.max(state.pointerRevision, m.revision); removePointer(); }
    if (m.phase === 'waiting') {
      const wait = Math.max(0, 500 - (performance.now() - (state.busyAt ?? 0)));
      state.idle = setTimeout(() => activity('waiting'), wait);
    } else { state.busyAt = performance.now(); activity(m.phase); }
  } else if (m.action === 'show' || m.action === 'focus') {
    if (m.revision <= state.pointerRevision) return;
    state.pointerRevision = m.revision;
    if (m.action === 'focus') showFocus(); else show(m.x, m.y, m.phase);
  } else return;
  clearTimeout(state.expiry);
  state.expiry = setTimeout(() => { state.floor = Math.max(state.floor, m.revision); remove(); }, m.expiresAt - Date.now());
}
if (!world.__dshFeedbackListenerV2) {
  world.__dshFeedbackListenerV2 = true;
  // Extension reload invalidates old script contexts but can leave their DOM
  // behind. Retire only our inert, hidden presentation markers on first boot.
  document.querySelectorAll('[data-dsh-pointer="v1"][aria-hidden="true"][inert], [data-dsh-activity="v1"][aria-hidden="true"][inert]')
    .forEach(host => host.remove());
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, respond) => {
    if ((raw as Partial<Feedback> | null)?.type !== feedbackType) return;
    receive(raw); respond({ ok: true, version: 2 });
  });
  // New documents regain the control indicator, but never an invented cursor.
  void chrome.runtime.sendMessage({ type: feedbackType, action: 'ready' }).then(receive).catch(() => {});
}
