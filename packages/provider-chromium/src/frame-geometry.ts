import { BrowserError, checkAbort } from '../../contracts/src/index.js';
import { geometryFunction } from './actionability.js';

export interface FramePoint { x: number; y: number }
export interface FrameViewport { width: number; height: number }
/** Ordered content corners: top-left, top-right, bottom-right, bottom-left.
 * Coordinates MUST be in the explicitly named parent viewport, not page/DPR
 * coordinates or an inferred CDP session root. Acquisition owns that conversion. */
export type FrameQuad = readonly [number, number, number, number, number, number, number, number];
export interface FrameBoundary {
  frameId: string; documentEpoch: string; parentId: string; parentDocumentEpoch: string;
  viewport: FrameViewport; parentViewport: FrameViewport; contentQuad: FrameQuad;
}
type Matrix = readonly [number, number, number, number, number, number, number, number, number];
const invalid = (): never => { throw new BrowserError('NOT_ACTIONABLE', 'Frame geometry is invalid or degenerate'); };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e7;
function size(v: FrameViewport) {
  if (!v || !finite(v.width) || !finite(v.height) || v.width <= 0 || v.height <= 0) invalid();
}
function point(p: FramePoint, v?: FrameViewport) {
  if (!p || !finite(p.x) || !finite(p.y) || v && (p.x < 0 || p.y < 0 || p.x >= v.width || p.y >= v.height)) invalid();
}
function transform(m: Matrix, p: FramePoint): FramePoint {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10) invalid();
  const result = { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
  point(result); return result;
}
function inverse(m: Matrix): Matrix {
  const [a,b,c,d,e,f,g,h,i] = m;
  const out = [e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d] as const;
  const determinant = a*out[0]+b*out[3]+c*out[6];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) invalid();
  return out.map(value => value / determinant) as unknown as Matrix;
}
/** Projective unit-square to convex quad mapping. Unlike bounding boxes or an
 * affine-only map this retains rotation, reflection and CSS perspective. */
function matrix(quad: FrameQuad): Matrix {
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(finite)) invalid();
  const q = Array.from({ length: 4 }, (_, index) => ({ x: quad[index*2]!, y: quad[index*2+1]! }));
  let sign = 0;
  for (let n = 0; n < 4; n++) {
    const a = q[n]!, b = q[(n+1)%4]!, c = q[(n+2)%4]!;
    const cross = (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-5 || sign && Math.sign(cross) !== sign) invalid();
    sign = Math.sign(cross);
  }
  const [a,b,c,d] = q as [FramePoint,FramePoint,FramePoint,FramePoint];
  const dx1=b.x-c.x,dx2=d.x-c.x,dx3=a.x-b.x+c.x-d.x;
  const dy1=b.y-c.y,dy2=d.y-c.y,dy3=a.y-b.y+c.y-d.y;
  const divisor=dx1*dy2-dx2*dy1;
  if (Math.abs(divisor)<1e-10) invalid();
  const g=(dx3*dy2-dx2*dy3)/divisor,h=(dx1*dy3-dx3*dy1)/divisor;
  const result: Matrix=[b.x-a.x+g*b.x,d.x-a.x+h*d.x,a.x,b.y-a.y+g*b.y,d.y-a.y+h*d.y,a.y,g,h,1];
  // A projective horizon anywhere in the square makes the mapping unsafe.
  if ([1,1+g,1+h,1+g+h].some(w=>!Number.isFinite(w)||w<1e-8)) invalid();
  inverse(result); return result;
}
export function framePointToParent(p: FramePoint, viewport: FrameViewport, quad: FrameQuad): FramePoint {
  size(viewport); point(p, viewport);
  return transform(matrix(quad), { x: p.x/viewport.width, y: p.y/viewport.height });
}
/** Inverse is also used by acquisition to explicitly convert a session-root
 * quad into immediate-parent viewport coordinates. It is not a hit test. */
export function parentPointToFrame(p: FramePoint, viewport: FrameViewport, quad: FrameQuad): FramePoint {
  size(viewport); point(p);
  const normalized=transform(inverse(matrix(quad)),p);
  const result={x:normalized.x*viewport.width,y:normalized.y*viewport.height};point(result);return result;
}

/** Chromium's same-process child-document DOM box quad is normalized by that
 * document's inherited CSS zoom. Convert to root CSS viewport units using the
 * measured document/root device-scale ratio, NOT the absolute device DPR.
 * This is a Chromium acquisition adapter, not a generic OOPIF coordinate rule. */
export function cdpQuadToRootViewport(quad: FrameQuad, ownerDocumentScale: number, rootDocumentScale: number): FrameQuad {
  matrix(quad);
  if (![ownerDocumentScale,rootDocumentScale].every(value=>finite(value)&&value>0&&value<=64)) invalid();
  const ratio=ownerDocumentScale/rootDocumentScale;
  const result=quad.map(value=>value*ratio) as unknown as FrameQuad;
  matrix(result);return result;
}

const id = (value: unknown) => typeof value === 'string' && !!value && value.length <= 512;
function boundary(raw: FrameBoundary): FrameBoundary {
  if (!raw || ![raw.frameId,raw.documentEpoch,raw.parentId,raw.parentDocumentEpoch].every(id)) invalid();
  size(raw.viewport);size(raw.parentViewport);matrix(raw.contentQuad);
  return {frameId:raw.frameId,documentEpoch:raw.documentEpoch,parentId:raw.parentId,parentDocumentEpoch:raw.parentDocumentEpoch,
    viewport:{width:raw.viewport.width,height:raw.viewport.height},parentViewport:{width:raw.parentViewport.width,height:raw.parentViewport.height},
    contentQuad:[...raw.contentQuad] as FrameQuad};
}
export interface FrameHitSource {
  readBoundary(index: number, signal: AbortSignal): Promise<FrameBoundary>;
  /** Must test the exact already-bound iframe owner in its parent document;
   * returning true for an arbitrary element at the point is insufficient. */
  hitOwner(index: number, p: FramePoint, boundary: FrameBoundary, signal: AbortSignal): Promise<boolean>;
}
export interface FramePointBinding { frameId: string; documentEpoch: string; rootId: string; rootDocumentEpoch: string; depth: number }
/** A measurement primitive for the upcoming frame action path, NOT permission
 * or an input ticket. The caller must bind CDP sessions/objects, enforce origin
 * policy and rerun final gates before any input. No action is dispatched here. */
export async function verifyFramePoint(local: FramePoint, binding: FramePointBinding, source: FrameHitSource, signal: AbortSignal) {
  checkAbort(signal);
  if (!binding || ![binding.frameId,binding.documentEpoch,binding.rootId,binding.rootDocumentEpoch].every(id)
    || !Number.isInteger(binding.depth) || binding.depth < 1 || binding.depth > 32) invalid();
  // Freeze the request identity and candidate before acquisition yields. Neither
  // callbacks nor the caller may silently retarget an in-flight measurement.
  binding={frameId:binding.frameId,documentEpoch:binding.documentEpoch,rootId:binding.rootId,
    rootDocumentEpoch:binding.rootDocumentEpoch,depth:binding.depth};
  point(local);local={x:local.x,y:local.y};
  const chain: FrameBoundary[] = [], points: FramePoint[] = [], seen = new Set<string>();
  let frameId=binding.frameId,epoch=binding.documentEpoch,p={...local};
  for(let index=0;index<binding.depth;index++) {
    checkAbort(signal);const current=boundary(await source.readBoundary(index,signal));checkAbort(signal);
    if(current.frameId!==frameId||current.documentEpoch!==epoch||seen.has(frameId))
      throw new BrowserError('STALE_TARGET','Frame geometry chain changed');
    seen.add(frameId);
    if(index && (chain[index-1]!.parentViewport.width!==current.viewport.width || chain[index-1]!.parentViewport.height!==current.viewport.height))
      throw new BrowserError('STALE_TARGET','Frame viewport chain changed');
    p=framePointToParent(p,current.viewport,current.contentQuad);point(p,current.parentViewport);
    chain.push(current);points.push(p);frameId=current.parentId;epoch=current.parentDocumentEpoch;
  }
  if(frameId!==binding.rootId||epoch!==binding.rootDocumentEpoch||seen.has(frameId))
    throw new BrowserError('STALE_TARGET','Frame geometry does not reach the bound root');
  for(let pass=0;pass<2;pass++) for(let index=0;index<chain.length;index++) {
    checkAbort(signal);
    if(pass && JSON.stringify(boundary(await source.readBoundary(index,signal)))!==JSON.stringify(chain[index]))
      throw new BrowserError('STALE_TARGET','Frame geometry moved during verification');
    checkAbort(signal);
    if(!await source.hitOwner(index,{...points[index]!},structuredClone(chain[index]!),signal))
      throw new BrowserError('NOT_ACTIONABLE','Frame owner is clipped, obscured or not hit');
    checkAbort(signal);
  }
  return {point:{...p},local:{...local},chain,points};
}

/** Fixed parent-document function. The object is the bound iframe owner, not
 * a model-selected CSS selector. Pointer hit tests include open shadow roots. */
export const frameOwnerHitFunction = `function(point) {
  if(!this.isConnected||this.tagName!=='IFRAME'||!this.contentWindow) return false;
  const result=(${geometryFunction}).call(this,point);
  return result.ok===true;
}`;
