import { feedbackType, type Activity } from './feedback.js';
import type { Lease } from '../../contracts/src/index.js';

/** Visible-control feedback (activity badge, virtual pointer) for leased tabs. Presentation only:
 * it reads the live gates to stay in step with Stop/expiry but never grants or extends authority. */
export function createPresenter(gates: ReadonlyMap<number, Lease>) {
  type PointerPhase = 'move' | 'click' | 'wheel';
  const activityRequests = new Map<number, Map<symbol, Activity>>();
  const presentations = new Map<number, { revision: number; phase: Activity }>();
  const activityTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const pointerInjections = new Map<number, Promise<unknown>>();
  let feedbackRevision = Date.now() * 1000;
  function nextFeedbackRevision(): number {
    feedbackRevision = Math.max(feedbackRevision + 1, Date.now() * 1000); return feedbackRevision;
  }
  function showActivity(id: number, phase: Activity, resetPointer = false): void {
    clearTimeout(activityTimers.get(id)); activityTimers.delete(id);
    const lease = gates.get(id);
    if (!lease || lease.expiresAt <= Date.now()) return;
    if (phase === 'waiting') {
      // A burst of low-level reads gets one busy hint and one settled hint,
      // rather than two extension IPC messages for every CDP command.
      activityTimers.set(id, setTimeout(() => {
        activityTimers.delete(id);
        if (gates.get(id)?.token !== lease.token || lease.expiresAt <= Date.now() || activityRequests.get(id)?.size) return;
        const revision = nextFeedbackRevision(); presentations.set(id, { revision, phase });
        sendPointerFeedback(id, { action: 'activity', phase, revision });
      }, 180));
      return;
    }
    if (presentations.get(id)?.phase === phase && !resetPointer) return;
    const revision = nextFeedbackRevision(); presentations.set(id, { revision, phase });
    sendPointerFeedback(id, { action: 'activity', phase, revision, ...(resetPointer ? { resetPointer: true } : {}) });
  }

  function sendPointerFeedback(id: number, payload: Record<string, unknown>): void {
    const lease = gates.get(id);
    if (!lease || lease.expiresAt <= Date.now()) return;
    const current = () => gates.get(id)?.token === lease.token && lease.expiresAt > Date.now();
    const message = { ...payload, type: feedbackType, revision: payload.revision ?? nextFeedbackRevision(), expiresAt: lease.expiresAt };
    // Rendering never holds the action queue. A versioned acknowledgement also
    // detects old content scripts in pages that were open before an update.
    void (async () => {
      const response = await chrome.tabs.sendMessage(id, message, { frameId: 0 }).catch(() => undefined);
      if (response?.version === 2 || !current()) return;
      let injection = pointerInjections.get(id);
      if (!injection) {
        injection = chrome.scripting.executeScript({ target: { tabId: id }, files: ['pointer.js'] });
        pointerInjections.set(id, injection);
        void injection.finally(() => { if (pointerInjections.get(id) === injection) pointerInjections.delete(id); }).catch(() => {});
      }
      await injection;
      if (current()) await chrome.tabs.sendMessage(id, message, { frameId: 0 });
    })().catch(() => { /* Feedback failure never replays input or bypasses permissions. */ });
  }
  function showVirtualPointer(id: number, params: Record<string, unknown>, expectedToken: string): void {
    if (gates.get(id)?.token !== expectedToken) return;
    const type = params.type;
    if (type !== 'mousePressed' && type !== 'mouseReleased' && type !== 'mouseWheel') return;
    const x = Number(params.x), y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const phase: PointerPhase = type === 'mouseReleased' ? 'click' : type === 'mouseWheel' ? 'wheel' : 'move';
    // The persistent isolated content script keeps pointer rendering independent
    // from the action queue. Existing tabs receive it once on demand.
    const message = { type: feedbackType, action: 'show', x, y, phase };
    sendPointerFeedback(id, message);
  }
  function removeVirtualPointer(id: number): void {
    void chrome.tabs.sendMessage(id, { type: feedbackType, action: 'remove', revision: nextFeedbackRevision(), expiresAt: 0 }, { frameId: 0 }).catch(() => {});
  }
  /** Synchronous part of Stop for presentation state. */
  function forget(id: number): void {
    activityRequests.delete(id); presentations.delete(id);
    clearTimeout(activityTimers.get(id)); activityTimers.delete(id);
  }
  return { activityRequests, presentations, nextFeedbackRevision, showActivity, sendPointerFeedback, showVirtualPointer, removeVirtualPointer, forget };
}
