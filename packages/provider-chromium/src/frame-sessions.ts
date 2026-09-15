import { BrowserError, checkAbort, originOf } from '../../contracts/src/index.js';
import { frameGeometryFunctions } from './frame-geometry-functions.js';
import { frameQueryFunctions, frameWithinRootFunction } from './frame-query-functions.js';

type Dict = Record<string, any>;
type Context = { id: number; uniqueId?: string };
type Session = { id: string; parent?: string; contexts: Map<string, Context> };
export interface SourceFrame { frameId: string; parentId?: string; loaderId?: string; origin?: string;
  sessionId?: string; context?: Context }
export interface ScreenshotRedactionPlan { revision: number; frames: SourceFrame[]; quads: Array<readonly [number, number, number, number, number, number, number, number]>; frameCount: number }
export const frameSessionLimits = Object.freeze({ sessions: 32, frames: 256, depth: 32, contexts: 256, bytes: 128 * 1024 });
const validId = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 128;
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { exclude: true }] };

/** Structural/session metadata only. Auto-attachment never authorizes child AX,
 * DOM, screenshots or input, and the public tool never receives session/context IDs. */
export class FrameSessions {
  private readonly sessions = new Map<string, Session>([['', { id: '', contexts: new Map() }]]);
  private readonly pending = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private version = 0;
  private failed = false;
  private incomplete = false;
  private geometryReads = 0;
  constructor(private readonly send: (sessionId: string, method: string, params: Dict, signal: AbortSignal, beforeDispatch?: () => void) => Promise<Dict>,
    private readonly fatal: () => void = () => {}) {}
  get sessionCount() { return this.sessions.size; }
  /** Source-only input seam. Called after bound geometry/semantic checks inside
   * one extension queue operation, never with a point supplied over the wire. */
  async dispatchFramePointer(revision:number,phase:'mousePressed'|'mouseReleased',point:{x:number;y:number},signal:AbortSignal){
    if(!['mousePressed','mouseReleased'].includes(phase)||![point?.x,point?.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e7))
      throw new BrowserError('INVALID_REQUEST','Invalid bound frame pointer event');
    const check=()=>{this.check(signal);if(revision!==this.version)throw new BrowserError('STALE_TARGET','Frame changed before pointer input');};
    check();
    await this.command('','Input.dispatchMouseEvent',{type:phase,x:point.x,y:point.y,button:'left',clickCount:1},signal,check);
    check();
  }
  /** Internal, bounded read scope. The source caller must first validate the
   * complete origin/document chain. No caller-supplied JavaScript or input. */
  openGeometryRead(sessionId: string, revision: number, signal: AbortSignal) {
    return this.openObjectRead(sessionId, revision, signal, 'geometry');
  }
  openQueryRead(sessionId: string, revision: number, signal: AbortSignal) {
    return this.openObjectRead(sessionId, revision, signal, 'query');
  }
  private openObjectRead(sessionId: string, revision: number, signal: AbortSignal, mode: 'geometry' | 'query') {
    this.check(signal);
    const session=this.sessions.get(sessionId);
    if(!session||revision!==this.version) throw new BrowserError('STALE_TARGET','Frame geometry session changed');
    if(this.geometryReads>=8) throw new BrowserError('QUEUE_FULL','Frame geometry scope capacity reached');
    const objectGroup='dsh-frame-geometry-'+crypto.randomUUID();
    this.geometryReads++;let closed=false,calls=0;
    const check=()=>{
      this.check(signal);
      if(closed||revision!==this.version||this.sessions.get(sessionId)!==session)
        throw new BrowserError('STALE_TARGET','Frame geometry context changed');
    };
    return {
      send:async(method:string,params:Dict):Promise<Dict>=>{
        check();
        if(++calls>1024) throw new BrowserError('QUEUE_FULL','Frame geometry read budget reached');
        const keys=Object.keys(params),only=(allowed:string[])=>keys.every(key=>allowed.includes(key));
        const positive=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0;
        const object=(id:unknown)=>typeof id==='string'&&!!id&&id.length<=512;
        const valid=method==='Accessibility.enable'?keys.length===0
          :method==='Accessibility.getRootAXNode'?mode==='query'&&only(['frameId'])&&validId(params.frameId)
          :method==='Accessibility.getChildAXNodes'?mode==='query'&&only(['id','frameId'])&&validId(params.id)&&validId(params.frameId)
          :method==='Accessibility.queryAXTree'?mode==='query'&&only(['backendNodeId','accessibleName','role'])&&positive(params.backendNodeId)
            &&typeof params.accessibleName==='string'&&!!params.accessibleName.trim()&&params.accessibleName.length<=1000
            &&(params.role===undefined||typeof params.role==='string'&&params.role.length<=80&&/^[A-Za-z][A-Za-z0-9]*$/.test(params.role))
          :method==='Accessibility.getPartialAXTree'?params.fetchRelatives===false&&(mode==='geometry'
            ?only(['backendNodeId','fetchRelatives'])&&positive(params.backendNodeId)
            :only(['objectId','fetchRelatives'])&&object(params.objectId))
          :method==='DOM.getFrameOwner'?mode==='geometry'&&only(['frameId'])&&validId(params.frameId)
          :method==='DOM.resolveNode'?only(['backendNodeId','executionContextId'])&&positive(params.backendNodeId)&&positive(params.executionContextId)
          :method==='DOM.getBoxModel'?mode==='geometry'&&only(['objectId'])&&object(params.objectId)
          :method==='Runtime.callFunctionOn'?only(['objectId','functionDeclaration','arguments','returnByValue'])&&object(params.objectId)
            &&(mode==='geometry'?frameGeometryFunctions:frameQueryFunctions).has(params.functionDeclaration)&&params.returnByValue===true&&Array.isArray(params.arguments)
            &&(mode==='geometry'?params.arguments.length<=1&&params.arguments.every((a:Dict)=>a&&Object.keys(a).length===1&&a.value&&Object.keys(a.value).length===2
              &&Number.isFinite(a.value.x)&&Number.isFinite(a.value.y)&&Math.abs(a.value.x)<=1e7&&Math.abs(a.value.y)<=1e7)
              :params.functionDeclaration===frameWithinRootFunction?params.arguments.length===1&&params.arguments.every((a:Dict)=>a&&Object.keys(a).length===1&&object(a.objectId)):params.arguments.length===0)
          :false;
        if(!valid) throw new BrowserError('POLICY_DENIED','Command is not a fixed frame geometry read');
        params=method==='Runtime.callFunctionOn'?{...params,arguments:params.arguments.map((arg:Dict)=>mode==='query'?{objectId:arg.objectId}:{value:{x:arg.value.x,y:arg.value.y}})}:{...params};
        const result=await this.command(sessionId,method,method==='DOM.resolveNode'?{...params,objectGroup}:params,signal,check);
        check();return result;
      },
      close:async()=>{
        if(closed)return;closed=true;
        try {
          // A document revision may change, but this random group belongs only
          // to this scope. Never release it on a replacement session. Stop's
          // debugger detach releases all remaining browser-side handles.
          if(this.controller.signal.aborted||this.sessions.get(sessionId)!==session)return;
          await this.command(sessionId,'Runtime.releaseObjectGroup',{objectGroup},AbortSignal.timeout(1000),()=>{
            if(this.sessions.get(sessionId)!==session)throw new BrowserError('STALE_TARGET','Geometry cleanup session changed');
          });
        } catch(error) { this.fail();throw error; }
        finally {this.geometryReads--;}
      }
    };
  }
  /** Only fixed read operations, guarded by the graph revision captured AFTER
   * source-side authority validation. No Runtime evaluation, DOM or input. */
  async readCommand(sessionId: string, revision: number, method: string, params: Dict, signal: AbortSignal) {
    const check = () => {
      this.check(signal);
      if (revision !== this.version) throw new BrowserError('STALE_TARGET', 'Frame context changed before AX read');
    };
    check();
    if (!['Accessibility.enable', 'Accessibility.getRootAXNode', 'Accessibility.getChildAXNodes'].includes(method))
      throw new BrowserError('POLICY_DENIED', 'Frame command is not a bounded AX read');
    const result = await this.command(sessionId, method, params, signal, check); check(); return result;
  }
  /** Compute root-page boxes that safely cover every foreign/opaque frame branch.
   * Only direct root children are masked, so a foreign descendant cannot escape
   * through transforms or an out-of-process intermediate frame. */
  async screenshotRedactionPlan(origin: string, signal: AbortSignal): Promise<ScreenshotRedactionPlan> {
    const before = await this.snapshot(signal);
    if (before.truncated) throw new BrowserError('POLICY_DENIED', 'Screenshot frame authority is incomplete');
    const roots = before.frames.filter(frame => frame.parentId === undefined);
    if (roots.length !== 1 || roots[0]!.origin !== origin) throw new BrowserError('POLICY_DENIED', 'Screenshot root authority is unavailable');
    const root = roots[0]!, byId = new Map(before.frames.map(frame => [frame.frameId, frame]));
    const branches = new Set<string>();
    for (const frame of before.frames) {
      if (frame.frameId === root.frameId || frame.origin === origin) continue;
      let current = frame, depth = 0;
      while (current.parentId !== root.frameId) {
        if (!current.parentId || ++depth > frameSessionLimits.depth) {
          throw new BrowserError('POLICY_DENIED', 'Screenshot frame authority is incomplete');
        }
        const parent = byId.get(current.parentId);
        if (!parent) throw new BrowserError('POLICY_DENIED', 'Screenshot frame authority is incomplete');
        current = parent;
      }
      branches.add(current.frameId);
    }
    const quads: ScreenshotRedactionPlan['quads'] = [];
    try {
      for (const frameId of branches) {
        const owner = await this.command('', 'DOM.getFrameOwner', { frameId }, signal);
        if (!Number.isSafeInteger(owner.backendNodeId) || owner.backendNodeId <= 0) {
          throw new BrowserError('POLICY_DENIED', 'Cross-origin frame owner is unavailable');
        }
        const box = await this.command('', 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, signal);
        const quad = box.model?.border;
        if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value: unknown) => typeof value !== 'number'
          || !Number.isFinite(value) || Math.abs(value) > 1e7)) {
          throw new BrowserError('POLICY_DENIED', 'Cross-origin frame geometry is unavailable');
        }
        quads.push(quad as unknown as ScreenshotRedactionPlan['quads'][number]);
      }
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('POLICY_DENIED', 'Cross-origin frame could not be safely redacted');
    }
    const after = await this.snapshot(signal);
    if (after.revision !== before.revision || JSON.stringify(after.frames) !== JSON.stringify(before.frames)) {
      throw new BrowserError('STALE_TARGET', 'Frame documents changed during screenshot redaction planning');
    }
    return { revision: before.revision, frames: before.frames, quads, frameCount: branches.size };
  }
  dispose() { this.controller.abort(new BrowserError('LEASE_REVOKED', 'Frame session control ended')); this.sessions.clear(); this.version++; }
  private check(signal: AbortSignal) { checkAbort(signal); checkAbort(this.controller.signal); if (this.failed) throw new BrowserError('STALE_TARGET', 'Frame graph failed closed'); }
  private fail() { if (!this.failed && !this.controller.signal.aborted) { this.failed = true; this.fatal(); } }
  private removeTree(child: Session) {
    if (this.sessions.get(child.id) !== child) return;
    const removing = new Set([child.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const session of this.sessions.values()) if (session.parent !== undefined && removing.has(session.parent) && !removing.has(session.id)) {
        removing.add(session.id); changed = true;
      }
    }
    for (const id of removing) this.sessions.delete(id);
    this.version++;
  }
  private async command(id: string, method: string, params: Dict, caller = this.controller.signal, beforeDispatch?: () => void): Promise<Dict> {
    const signal = AbortSignal.any([caller, this.controller.signal]); this.check(signal);
    const session = this.sessions.get(id);
    if (!session) throw new BrowserError('STALE_TARGET', 'Frame session is no longer current');
    const result = await this.send(id, method, params, signal, beforeDispatch); this.check(signal);
    if (this.sessions.get(id) !== session) throw new BrowserError('STALE_TARGET', 'Frame session was replaced');
    return result;
  }
  private async configure(id: string) {
    await this.command(id, 'Page.enable', {});
    await this.command(id, 'Runtime.enable', {});
    await this.command(id, 'Target.setAutoAttach', autoAttach);
  }
  async start(signal: AbortSignal) {
    this.check(signal);
    await this.command('', 'Runtime.enable', {}, signal);
    await this.command('', 'Target.setAutoAttach', autoAttach, signal);
  }
  event(parentId: string, method: string, raw: unknown) {
    if (this.controller.signal.aborted || this.failed || !this.sessions.has(parentId)) return;
    const p = raw as Dict | undefined;
    if (!p || typeof p !== 'object') return;
    if (method === 'Target.attachedToTarget') {
      if (p.targetInfo?.type !== 'iframe') return;
      if (!validId(p.sessionId) || this.sessions.has(p.sessionId) || this.sessions.size >= frameSessionLimits.sessions) { this.fail(); return; }
      const child: Session = { id: p.sessionId, parent: parentId, contexts: new Map() };
      this.sessions.set(child.id, child); this.version++;
      const work = this.configure(child.id).catch(() => {
        // A normal detach may race initialization. Never let its old work poison a successor.
        if (this.sessions.get(child.id) === child) { this.removeTree(child); this.incomplete = true; }
      });
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const child = this.sessions.get(p.sessionId);
      if (!child || child.parent !== parentId) return;
      this.removeTree(child); return;
    }
    const session = this.sessions.get(parentId)!;
    if (method === 'Runtime.executionContextsCleared') { session.contexts.clear(); this.version++; }
    else if (method === 'Runtime.executionContextDestroyed') {
      for (const [frame, context] of session.contexts) if (p.executionContextUniqueId !== undefined
        ? context.uniqueId === p.executionContextUniqueId : context.id === p.executionContextId) session.contexts.delete(frame);
      this.version++;
    } else if (method === 'Runtime.executionContextCreated') {
      const context = p.context;
      if (context?.auxData?.isDefault !== true) return;
      const frame = context.auxData.frameId;
      if (!validId(frame) || !Number.isSafeInteger(context.id) || context.id <= 0 || context.uniqueId !== undefined && !validId(context.uniqueId)) { this.fail(); return; }
      const count = [...this.sessions.values()].reduce((sum, item) => sum + item.contexts.size, 0);
      if (!session.contexts.has(frame) && count >= frameSessionLimits.contexts) { this.fail(); return; }
      session.contexts.set(frame, { id: context.id, ...(context.uniqueId === undefined ? {} : { uniqueId: context.uniqueId }) }); this.version++;
    } else if (['Page.frameAttached', 'Page.frameDetached', 'Page.frameNavigated'].includes(method)) this.version++;
  }
  async snapshot(signal: AbortSignal): Promise<{ frames: SourceFrame[]; truncated: boolean; revision: number }> {
    this.check(signal);
    // Child auto-attach is recursive; newly attached children can add more setup work.
    for (let round = 0; this.pending.size && round < frameSessionLimits.depth; round++) {
      const linked = AbortSignal.any([signal, this.controller.signal]); let abort: (() => void) | undefined;
      try {
        await Promise.race([Promise.all([...this.pending]), new Promise<never>((_resolve, reject) => {
          abort = () => { try { this.check(linked); } catch (error) { reject(error); } };
          linked.addEventListener('abort', abort, { once: true }); if (linked.aborted) abort();
        })]);
      } finally { if (abort) linked.removeEventListener('abort', abort); }
      this.check(signal);
    }
    if (this.pending.size) throw new BrowserError('QUEUE_FULL', 'Frame setup depth budget reached');
    const version = this.version, trees: Array<{ session: Session; tree: Dict }> = [];
    for (const session of this.sessions.values()) {
      const result = await this.command(session.id, 'Page.getFrameTree', {}, signal);
      if (!result.frameTree?.frame) throw new BrowserError('STALE_TARGET', 'Frame tree is unavailable');
      trees.push({ session, tree: result.frameTree });
    }
    this.check(signal);
    if (this.version !== version) throw new BrowserError('STALE_TARGET', 'Frame topology changed during discovery');
    const frames = new Map<string, SourceFrame>(); let truncated = this.incomplete;
    // Root-session tree supplies ownership/parentage. Child-session trees fill in
    // their authoritative document/context route; targetId is never guessed as frameId.
    const append = (tree: Dict, session: Session, remoteRoot = false) => {
      const queue: Array<{ tree: Dict; parent?: string; depth: number }> = [{ tree, depth: 0 }];
      const seen = new Set<string>();
      for (let index = 0; index < queue.length; index++) {
        const { tree: item, parent, depth } = queue[index]!; const raw = item.frame;
        if (!raw || !validId(raw.id) || raw.loaderId !== undefined && typeof raw.loaderId !== 'string') throw new BrowserError('STALE_TARGET', 'Invalid frame identity');
        if (raw.loaderId?.length > 128) throw new BrowserError('QUEUE_FULL', 'Frame identity exceeds budget');
        if (seen.has(raw.id) || raw.parentId !== undefined && !validId(raw.parentId)
          || parent !== undefined && raw.parentId !== undefined && parent !== raw.parentId) throw new BrowserError('STALE_TARGET', 'Invalid frame parentage');
        seen.add(raw.id);
        const existing = frames.get(raw.id);
        const parentId = parent ?? (validId(raw.parentId) ? raw.parentId : existing?.parentId);
        if (remoteRoot && index === 0 && !existing && (!parentId || !frames.has(parentId))) { truncated = true; return; }
        if (existing && existing.parentId !== parentId) throw new BrowserError('STALE_TARGET', 'Frame parent changed during discovery');
        if (existing?.loaderId && raw.loaderId && existing.loaderId !== raw.loaderId) throw new BrowserError('STALE_TARGET', 'Frame document changed during discovery');
        if (!existing && frames.size >= frameSessionLimits.frames) { truncated = true; continue; }
        let origin: string | undefined;
        try { origin = originOf(raw.securityOrigin || raw.url); } catch { /* Opaque/non-HTTP frame: no inferred parent authority. */ }
        const context = session.contexts.get(raw.id);
        frames.set(raw.id, { frameId: raw.id, ...(parentId ? { parentId } : {}),
          ...(raw.loaderId ? { loaderId: raw.loaderId } : {}), ...(origin ? { origin } : {}),
          // A known context is required to associate a same-process frame with a session.
          ...(context ? { sessionId: session.id, context: { ...context } } : {}) });
        const children = item.childFrames ?? [];
        if (!Array.isArray(children)) throw new BrowserError('STALE_TARGET', 'Invalid frame children');
        if (depth >= frameSessionLimits.depth) { if (children.length) truncated = true; continue; }
        const take = Math.min(children.length, frameSessionLimits.frames - queue.length);
        if (take < children.length) truncated = true;
        for (const child of children.slice(0, take)) queue.push({ tree: child, parent: raw.id, depth: depth + 1 });
      }
    };
    append(trees[0]!.tree, trees[0]!.session);
    // Attachment order is parent-first, so every child root can resolve its parent.
    for (const { session, tree } of trees.slice(1)) append(tree, session, true);
    const result = { frames: [...frames.values()], truncated, revision: version };
    if (new TextEncoder().encode(JSON.stringify(result)).length > frameSessionLimits.bytes)
      throw new BrowserError('QUEUE_FULL', 'Frame inventory exceeds byte budget');
    return result;
  }
}
