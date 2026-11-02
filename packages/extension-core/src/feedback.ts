// Local presentation only. These messages never dispatch input or grant control.
export const feedbackType = 'dsh.pointer.v2';
export type PointerPhase = 'move' | 'click' | 'wheel' | 'typing';
export type Activity = 'controlled' | 'reading' | 'navigating' | 'capturing' | 'acting' | 'waiting';
export type Feedback = { type: typeof feedbackType; revision: number; expiresAt: number } & (
  { action: 'show'; x: number; y: number; phase: PointerPhase }
  | { action: 'focus' }
  | { action: 'activity'; phase: Activity; resetPointer?: boolean }
  | { action: 'remove' }
);
export const activityLabels: Record<Activity, string> = {
  controlled: '浏览器已接管', reading: '正在读取页面', navigating: '正在导航',
  capturing: '正在截图', acting: '正在操作', waiting: '等待下一步',
};
