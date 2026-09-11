/** Browser-independent contracts. This package must not import a browser SDK. */
export const errorCodes = ['INVALID_REQUEST', 'POLICY_DENIED', 'LEASE_BUSY', 'LEASE_REVOKED',
  'USER_STOPPED', 'CANCELLED', 'DEADLINE_EXCEEDED', 'QUEUE_FULL', 'CONNECTION_LOST', 'PROTOCOL_MISMATCH',
  'STALE_TARGET', 'AMBIGUOUS_TARGET', 'NOT_ACTIONABLE', 'UNSUPPORTED_CAPABILITY', 'NAVIGATION_FAILED',
  'VISION_UNAVAILABLE', 'REQUEST_ID_CONFLICT', 'JOURNAL_FULL', 'JOURNAL_UNAVAILABLE', 'RECOVERY_REQUIRED',
  'BROKER_BUSY', 'BROKER_STATE_UNSAFE', 'INTERNAL_ERROR'] as const;
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
export interface Lease {
  id: string;
  owner: string;
  tab: string;
  instanceId: string;
  token: string;
  origin: string;
  expiresAt: number;
}
export interface NodeRef {
  id: string;
  role: string;
  name: string;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  value?: string;
  /** Named structural region: valid as an observation root, not an input target. */
  kind?: 'region';
}
export interface SemanticQuery { name: string; role?: string }
export type ObservationScope = { kind: 'document' } | { kind: 'subtree'; rootRef: string }
  | { kind: 'query'; query: SemanticQuery; rootRef?: string };
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
export interface ObserveOptions { cursor?: string; rootRef?: string; query?: SemanticQuery }
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
}
export type Expected = { kind: 'value'; value: string } | { kind: 'url'; url: string } | { kind: 'text'; text: string };
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
  | { kind: 'press'; ref: string; key: BrowserKey; shift?: boolean; expected?: Expected }
  | { kind: 'scroll'; ref?: string; deltaX: number; deltaY: number; expected?: Expected }
  | { kind: 'navigate'; url: string; expected?: Expected };
export interface ActionRequest {
  requestId: string;
  leaseId: string;
  documentEpoch: string;
  action: Action;
  timeoutMs?: number;
}
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
  capture?(lease: Lease, signal: AbortSignal): Promise<Screenshot>;
  act(lease: Lease, request: ActionRequest, execution: ProviderExecution): Promise<ProviderResult>;
}
export interface AuthorizationRequest {
  owner: string;
  tab: TabSummary;
  operation: 'claim' | 'observe' | 'act';
  action?: Action;
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
