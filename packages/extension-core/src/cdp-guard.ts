import { BrowserError, originOf, type Lease } from '../../contracts/src/index.js';
import { record, string, uploadFile } from '../../contracts/src/validation.js';
import { allowedKeyEvent } from '../../provider-chromium/src/keyboard.js';
import { allowedMouseEvent } from '../../provider-chromium/src/mouse.js';
import { pageFunctions } from '../../provider-chromium/src/page-functions.js';
import { settleFrameFunction } from '../../provider-chromium/src/actionability.js';

/** The only CDP methods the extension will forward for a leased root session. */
export const cdpMethods = new Set(['Page.getFrameTree', 'DOM.resolveNode', 'DOM.getDocument',
  'Runtime.callFunctionOn', 'Runtime.releaseObject', 'Input.insertText', 'Input.dispatchMouseEvent',
  'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Accessibility.getPartialAXTree',
  'DOM.scrollIntoViewIfNeeded', 'Input.dispatchKeyEvent', 'Page.navigate', 'Runtime.evaluate',
  'Page.createIsolatedWorld', 'DOM.setFileInputFiles', 'Page.setInterceptFileChooserDialog', 'Page.handleFileChooser', 'Page.handleJavaScriptDialog']);

/** Per-call facts the guard needs; it holds no state and performs no browser I/O. */
export type CdpGuardEnv = { lease: Lease; allowedOrigin: string | undefined; pendingDialog: Record<string, unknown> | undefined };

/** Last line of defence: each exposed command is accepted only in its fixed, reviewed shape. Throws on anything else. */
export function checkCdpCommand(command: string, params: Record<string, unknown>, env: CdpGuardEnv): void {
  const { lease } = env;
  if (!cdpMethods.has(command)) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'CDP method is not exposed');
  if (command === 'DOM.getDocument' && (params.depth !== 0 || params.pierce !== false || Object.keys(params).length !== 2)) {
    throw new BrowserError('POLICY_DENIED', 'Only the root document handle is exposed');
  }
  if (command === 'Input.dispatchKeyEvent' && !allowedKeyEvent(params)) {
    throw new BrowserError('POLICY_DENIED', 'Only canonical page-key events are exposed');
  }
  if (command === 'Input.dispatchMouseEvent' && !allowedMouseEvent(params)) {
    throw new BrowserError('POLICY_DENIED', 'Only canonical left-click and unmodified wheel events are exposed');
  }
  if (command === 'Page.navigate') {
    const targetOrigin = originOf(string(params.url, 8192));
    if (targetOrigin !== lease.origin || (lease.scope ?? 'origin') === 'origin' && targetOrigin !== env.allowedOrigin) {
      throw new BrowserError('POLICY_DENIED', 'Navigation target is outside the lease scope');
    }
  }
  if (command === 'DOM.resolveNode' && (Object.keys(params).some(key => !['backendNodeId', 'executionContextId'].includes(key))
    || !Number.isSafeInteger(params.backendNodeId) || Number(params.backendNodeId) < 1
    || params.executionContextId !== undefined && (!Number.isSafeInteger(params.executionContextId) || Number(params.executionContextId) < 1))) {
    throw new BrowserError('POLICY_DENIED', 'Only a backend node and optional execution context may be resolved');
  }
  if (command === 'Page.createIsolatedWorld' && (Object.keys(params).length !== 2 || typeof params.frameId !== 'string'
    || !params.frameId || params.frameId.length > 128 || params.worldName !== 'dsh-native-browser')) {
    throw new BrowserError('POLICY_DENIED', 'Only the extension isolated world may be created');
  }
  if (command === 'Runtime.callFunctionOn') {
    // Root-session calls run only the fixed, reviewed functions; arguments are plain values or object handles.
    const args = params.arguments;
    if (Object.keys(params).some(key => !['objectId', 'functionDeclaration', 'arguments', 'returnByValue', 'awaitPromise'].includes(key))
      || typeof params.objectId !== 'string' || !params.objectId || params.objectId.length > 4096
      || typeof params.functionDeclaration !== 'string' || !pageFunctions.has(params.functionDeclaration)
      || params.returnByValue !== undefined && typeof params.returnByValue !== 'boolean'
      || params.awaitPromise !== undefined && (typeof params.awaitPromise !== 'boolean' || params.awaitPromise === true && params.functionDeclaration !== settleFrameFunction)
      || args !== undefined && (!Array.isArray(args) || args.length > 4 || args.some(arg => {
        const a = record(arg), keys = Object.keys(a);
        return keys.length !== 1 || (keys[0] === 'objectId' ? typeof a.objectId !== 'string' || !a.objectId || a.objectId.length > 4096
          : keys[0] !== 'value' || !(typeof a.value === 'number' && Number.isFinite(a.value) || typeof a.value === 'boolean'
            || typeof a.value === 'string' && a.value.length <= 64 || a.value !== null && typeof a.value === 'object' && !Array.isArray(a.value)
              && Object.keys(a.value).length === 2 && Number.isFinite((a.value as any).x) && Number.isFinite((a.value as any).y)));
      }))) {
      throw new BrowserError('POLICY_DENIED', 'Only fixed page functions with plain arguments may run');
    }
  }
  if (command === 'Runtime.evaluate' && (params.expression !== 'document.readyState' || params.returnByValue !== true
    || Object.keys(params).some(key => !['expression', 'returnByValue'].includes(key)))) {
    throw new BrowserError('POLICY_DENIED', 'Only the fixed document-readiness query is exposed');
  }
  if (command === 'DOM.setFileInputFiles') {
    const files = params.files;
    if (Object.keys(params).length !== 2 || typeof params.objectId !== 'string' || !params.objectId || params.objectId.length > 4096
      || !Array.isArray(files) || files.length < 1 || files.length > 64) {
      throw new BrowserError('POLICY_DENIED', 'File selection requires one resolved file input and bounded local files');
    }
    try { files.forEach(uploadFile); }
    catch { throw new BrowserError('POLICY_DENIED', 'Upload files must be absolute local paths'); }
  }
  if (command === 'Page.setInterceptFileChooserDialog') {
    if (Object.keys(params).length !== 1 || params.enabled !== true) {
      throw new BrowserError('POLICY_DENIED', 'File chooser interception only enables for the leased tab');
    }
  }
  if (command === 'Page.handleFileChooser') {
    const files = params.files;
    if (params.action !== 'accept' || Object.keys(params).length !== 2 || !Array.isArray(files)
      || files.length < 1 || files.length > 64) {
      throw new BrowserError('POLICY_DENIED', 'File chooser accept requires bounded local files');
    }
    try { files.forEach(uploadFile); }
    catch { throw new BrowserError('POLICY_DENIED', 'Chosen files must be absolute local paths'); }
  }
  if (command === 'Page.handleJavaScriptDialog') {
    if (typeof params.accept !== 'boolean' || Object.keys(params).some(key => !['accept', 'promptText'].includes(key))
      || params.promptText !== undefined && (typeof params.promptText !== 'string' || params.promptText.length > 1000 || !params.accept)) {
      throw new BrowserError('POLICY_DENIED', 'JavaScript dialogs accept only a boolean and bounded prompt text');
    }
    const pending = env.pendingDialog;
    if (!pending) throw new BrowserError('NOT_ACTIONABLE', 'No JavaScript dialog is pending on the leased tab');
    if (params.promptText !== undefined && pending.type !== 'prompt') {
      throw new BrowserError('POLICY_DENIED', 'Prompt text is only valid for a JavaScript prompt dialog');
    }
  }
}
