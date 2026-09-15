/** Browser-independent contracts. This package must not import a browser SDK. */
export const errorCodes = ['INVALID_REQUEST', 'POLICY_DENIED', 'LEASE_BUSY', 'LEASE_REVOKED',
  'USER_STOPPED', 'CANCELLED', 'DEADLINE_EXCEEDED', 'QUEUE_FULL', 'CONNECTION_LOST', 'PROTOCOL_MISMATCH',
  'STALE_TARGET', 'AMBIGUOUS_TARGET', 'NOT_ACTIONABLE', 'UNSUPPORTED_CAPABILITY', 'NAVIGATION_FAILED',
  'VISION_UNAVAILABLE', 'REQUEST_ID_CONFLICT', 'JOURNAL_FULL', 'JOURNAL_UNAVAILABLE', 'RECOVERY_REQUIRED',
  'BROKER_BUSY', 'BROKER_STATE_UNSAFE', 'INSTALLATION_BUSY', 'INSTALLATION_FAILED', 'INTERNAL_ERROR'] as const;
export type ErrorCode = typeof errorCodes[number];

export class BrowserError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export interface BrowserInstance {
  id: string;
  family: 'chromium' | 'webdriver-bidi' | 'other';
  brand: string;
  version: string;
  profileLabel: string;
  capabilities: Record<string, boolean>;
}
export interface TabSummary { id: string; instanceId: string; url: string; title: string }
/** Structural metadata, not authorization to read or act in a child document. */
export interface FrameSummary {
  id: string; parentId?: string; isMain: boolean; documentEpoch?: string; origin?: string;
  originRelation: 'same-origin' | 'cross-origin' | 'opaque';
  contextStatus: 'known' | 'unavailable';
}
export interface FrameInventory { tab: string; documentEpoch: string; frames: FrameSummary[]; truncated: boolean }
export interface Lease {
  id: string;
  owner: string;
  tab: string;
  instanceId: string;
  token: string;
  origin: string;
  /** `tab` is an explicit personal-mode capability; omission means exact-origin. */
  scope?: 'origin' | 'tab';
  expiresAt: number;
}
export interface NodeRef {
  id: string;
  role: string;
  name: string;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  /** Observed editing capability; current DOM/focus/selection must still be verified. */
  editable?: boolean;
  value?: string;
  /** Named structural region: valid as an observation root, not an input target. */
  kind?: 'region';
}
export interface SemanticQuery { name: string; role?: string }
export type ObservationScope = { kind: 'document' } | { kind: 'subtree'; rootRef: string; frameId?: string }
  | { kind: 'frame'; frameId: string }
  | { kind: 'query'; query: SemanticQuery; rootRef?: string; frameId?: string };
export interface Observation {
  tab: string;
  url: string;
  title: string;
  documentEpoch: string;
  revision: number;
  nodes: NodeRef[];
  text: string[];
  truncated: boolean;
  /** Legacy providers may omit this only for whole-document observations. */
  scope?: ObservationScope;
}
export interface FrameTarget { frameId: string; documentEpoch: string }
export interface ObserveOptions { cursor?: string; rootRef?: string; query?: SemanticQuery; frame?: FrameTarget }
export interface PageReadOptions { frame?: FrameTarget; rootRef?: string; continuation?: string }
/** Live traversal window, not an incremental snapshot or atomic whole-page read. */
export interface ObservationPage extends Observation {
  page: { index: number; incomplete: boolean; continuation?: string };
}
export interface FullObservation extends Observation {
  scope: ObservationScope;
  format: 'full';
  cursor: string;
  resyncRequired: boolean;
  resyncReason?: 'cursor-unavailable' | 'document-changed' | 'scope-changed';
}
export interface ObservationDelta {
  format: 'delta';
  cursor: string;
  baseCursor: string;
  resyncRequired: false;
  tab: string;
  url: string;
  title: string;
  documentEpoch: string;
  revision: number;
  truncated: boolean;
  scope: ObservationScope;
  nodes: { upsert: NodeRef[]; remove: string[]; order?: string[] };
  /** One contiguous splice relative to the exact base cursor's text array. */
  text?: { start: number; deleteCount: number; insert: string[] };
}
export type ObservationUpdate = FullObservation | ObservationDelta;
export interface Screenshot {
  tab: string;
  documentEpoch: string;
  capturedAt: number;
  mimeType: 'image/jpeg';
  data: string;
  viewport: { width: number; height: number; pageX: number; pageY: number };
  /** Foreign/opaque frame branches are removed inside the browser extension
   * before pixels cross Native Messaging. */
  redaction: { policy: 'cross-origin-frames'; frames: number; regions: number };
}
export const elementStates = ['attached', 'detached', 'visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked'] as const;
export type ElementState = typeof elementStates[number];
export type Expected = { kind: 'value'; value: string } | { kind: 'url'; url: string } | { kind: 'text'; text: string }
  | { kind: 'state'; ref: string; state: ElementState };
export const browserKeys = ['Enter', 'Tab', 'Escape', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete'] as const;
export type BrowserKey = typeof browserKeys[number];
export interface ScrollPosition {
  x: number; y: number;
  scrollWidth: number; scrollHeight: number;
  clientWidth: number; clientHeight: number;
}
export interface ScrollEvidence {
  target: { kind: 'document' } | { kind: 'element'; ref: string };
  requested: { deltaX: number; deltaY: number };
  before: ScrollPosition;
  after: ScrollPosition;
  moved: boolean;
}
export type Action =
  | { kind: 'check'; ref: string; checked: boolean; expected?: Expected }
  | { kind: 'click'; ref: string; expected?: Expected }
  | { kind: 'fill'; ref: string; text: string; expected?: Expected }
  | { kind: 'append'; ref: string; text: string; expected?: Expected }
  | { kind: 'press'; ref: string; key: BrowserKey; shift?: boolean; expected?: Expected }
  | { kind: 'scroll'; ref?: string; deltaX: number; deltaY: number; expected?: Expected }
  | { kind: 'wheel'; ref: string; deltaX: number; deltaY: number; expected?: Expected }
  | { kind: 'navigate'; url: string; expected?: Expected };
export interface ActionRequest {
  requestId: string;
  leaseId: string;
  documentEpoch: string;
  action: Action;
  /** Explicit child scope; documentEpoch must equal frame.documentEpoch. */
  frame?: FrameTarget;
  timeoutMs?: number;
}
export interface BatchRequest {
  requestId: string;
  leaseId: string;
  documentEpoch: string;
  steps: Array<{ action: Action; timeoutMs?: number }>;
  timeoutMs?: number;
}
export type BatchStepResult = { index: number; status: 'notRun' } | { index: number; status: 'attempted';
  result: Omit<ActionResult, 'observation' | 'scroll'> };
export interface BatchResult extends ActionResult {
  totalSteps: number;
  /** Absent on metadata-only recovery: past step progress is then unknown. */
  steps?: BatchStepResult[];
}
/** Host-specific approval stays outside the portable runtime; every step needs a fresh grant. */
export type ApproveBatchStep = (index: number, signal: AbortSignal) => Promise<boolean>;
export interface ActionResult {
  requestId: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  dispatch: 'notDispatched' | 'dispatched' | 'observed';
  postcondition: 'passed' | 'failed' | 'unverified';
  code?: ErrorCode;
  observation?: FullObservation;
  scroll?: ScrollEvidence;
  /** Historical metadata only. Never an assertion about the current page or restored authority. */
  recovery?: import('./journal.js').RecoveryRecord;
}
export interface ProviderExecution {
  signal: AbortSignal;
  /** Called immediately BEFORE any potentially side-effecting command. */
  onDispatch(): void;
}
export interface ProviderResult {
  observation: Observation;
  postcondition: 'passed' | 'failed' | 'unverified';
  scroll?: ScrollEvidence;
}
export interface BrowserProvider {
  readonly instance: BrowserInstance;
  listTabs(signal: AbortSignal): Promise<TabSummary[]>;
  grant(lease: Lease, signal: AbortSignal): Promise<void>;
  revoke(lease: Lease): Promise<void>;
  observe(lease: Lease, signal: AbortSignal): Promise<Observation>;
  observeSubtree?(lease: Lease, rootRef: string, signal: AbortSignal): Promise<Observation>;
  find?(lease: Lease, query: SemanticQuery, signal: AbortSignal, rootRef?: string): Promise<Observation>;
  readPage?(lease: Lease, options: PageReadOptions, signal: AbortSignal): Promise<ObservationPage>;
  readFramePage?(lease: Lease, options: PageReadOptions & { frame: FrameTarget }, signal: AbortSignal): Promise<ObservationPage>;
  frames?(lease: Lease, signal: AbortSignal): Promise<FrameInventory>;
  observeFrame?(lease: Lease, frame: FrameTarget, signal: AbortSignal): Promise<Observation>;
  findFrame?(lease: Lease, frame: FrameTarget, query: SemanticQuery, signal: AbortSignal, rootRef?: string): Promise<Observation>;
  observeFrameSubtree?(lease: Lease, frame: FrameTarget, rootRef: string, signal: AbortSignal): Promise<Observation>;
  capture?(lease: Lease, signal: AbortSignal): Promise<Screenshot>;
  act(lease: Lease, request: ActionRequest, execution: ProviderExecution): Promise<ProviderResult>;
  actFrame?(lease: Lease, request: ActionRequest, execution: ProviderExecution): Promise<ProviderResult>;
}
export interface AuthorizationRequest {
  owner: string;
  tab: TabSummary;
  operation: 'claim' | 'observe' | 'act';
  action?: Action;
  frame?: FrameTarget;
}
export type Authorize = (request: AuthorizationRequest, signal: AbortSignal) => Promise<boolean>;

export function originOf(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserError('POLICY_DENIED', 'Invalid page URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserError('POLICY_DENIED', 'Only credential-free HTTP(S) page URLs are supported');
  }
  return url.origin;
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    if (signal.reason instanceof BrowserError) throw signal.reason;
    throw new BrowserError('CANCELLED', 'Operation cancelled');
  }
}

export function errorCode(error: unknown): ErrorCode {
  return error instanceof BrowserError ? error.code : 'INTERNAL_ERROR';
}
