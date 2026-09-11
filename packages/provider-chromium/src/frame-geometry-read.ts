import { BrowserError, checkAbort } from '../../contracts/src/index.js';
import { record } from '../../contracts/src/validation.js';
import { bindFrameDocument, frameReadBinding } from './frame-read.js';
import type { FrameSessions } from './frame-sessions.js';
import { cdpQuadToRootViewport, parentPointToFrame, verifyFramePoint, type FrameQuad, type FrameViewport } from './frame-geometry.js';
import { frameTargetGeometryFunction, frameBoundOwnerHitFunction, frameOwnerMetricsFunction } from './frame-geometry-functions.js';

type Dict = Record<string, any>;
const stale = (): never => { throw new BrowserError('STALE_TARGET','Bound frame geometry changed'); };
const invalid = (): never => { throw new BrowserError('NOT_ACTIONABLE','Bound frame geometry is unavailable'); };
export function frameGeometryRequest(raw: unknown) {
  const v=record(raw);
  if(Object.keys(v).some(key=>!['binding','backendNodeId'].includes(key))||!Number.isSafeInteger(v.backendNodeId)||Number(v.backendNodeId)<=0)
    throw new BrowserError('INVALID_REQUEST','Invalid bound frame geometry request');
  return {binding:frameReadBinding(v.binding),backendNodeId:Number(v.backendNodeId)};
}
function viewport(raw: Dict): FrameViewport {
  if(!raw||![raw.width,raw.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e7))invalid();
  return {width:raw.width,height:raw.height};
}
function targetGeometry(raw: Dict) {
  if(!raw||raw.ok!==true||!['x','y','left','top','width','height'].every(k=>typeof raw[k]==='number'&&Number.isFinite(raw[k])&&Math.abs(raw[k])<=1e7))invalid();
  return {x:raw.x as number,y:raw.y as number,left:raw.left as number,top:raw.top as number,width:raw.width as number,height:raw.height as number};
}

/** Production source acquisition, not an input command or reusable authority.
 * Only the currently bound same-origin, same-process ancestor chain is read.
 * Foreign siblings are neither read nor required to share this authorization. */
export async function withBoundFrameGeometry(graph: FrameSessions, raw: unknown, origin: string, signal: AbortSignal,
  use?: (bound:{recheck:()=>Promise<void>;identity:()=>Promise<Dict>;click:()=>Promise<void>})=>Promise<void>) {
  const request=frameGeometryRequest(raw);
  const {binding,before,target,root,ancestry}=await bindFrameDocument(graph,request.binding,origin,signal);
  if(ancestry.length>33)throw new BrowserError('QUEUE_FULL','Frame geometry depth limit reached');
  if(ancestry.some(frame=>!frame.loaderId||!frame.context?.uniqueId))
    throw new BrowserError('UNSUPPORTED_CAPABILITY','Frame geometry requires unique ancestor contexts');
  if(ancestry.some(frame=>frame.sessionId!==root.sessionId))
    throw new BrowserError('UNSUPPORTED_CAPABILITY','OOPIF geometry acquisition is not yet supported');
  const scope=graph.openGeometryRead(target.sessionId!,before.revision,signal),owners:string[]=[];
  let result:{point:{x:number;y:number};local:{x:number;y:number};depth:number};
  try {
    const call=async(objectId:string,fn:string,args:unknown[]=[])=>{
      const response=await scope.send('Runtime.callFunctionOn',{objectId,functionDeclaration:fn,arguments:args.map(value=>({value})),returnByValue:true});
      if(response.exceptionDetails)invalid();
      return response.result?.value;
    };
    const resolve=async(backendNodeId:number,executionContextId:number)=>{
      const response=await scope.send('DOM.resolveNode',{backendNodeId,executionContextId});
      const id=response.object?.objectId;
      if(typeof id!=='string'||!id||id.length>512)stale();return id as string;
    };
    const targetObject=await resolve(request.backendNodeId,target.context!.id);
    const initial=targetGeometry(await call(targetObject,frameTargetGeometryFunction));
    for(let index=0;index<ancestry.length-1;index++){
      const owner=await scope.send('DOM.getFrameOwner',{frameId:ancestry[index]!.frameId});
      owners.push(await resolve(owner.backendNodeId,ancestry[index+1]!.context!.id));
    }
    const metrics=async(index:number)=>{
      const raw=await call(owners[index]!,frameOwnerMetricsFunction);
      if(!raw||typeof raw.scale!=='number'||!Number.isFinite(raw.scale)||raw.scale<=0||raw.scale>64)invalid();
      return {viewport:viewport(raw.viewport),parentViewport:viewport(raw.parentViewport),scale:raw.scale as number};
    };
    const rootMetrics=await metrics(owners.length-1);
    const sample=async(index:number)=>{
      const m=await metrics(index);
      const box=await scope.send('DOM.getBoxModel',{objectId:owners[index]});
      return {metrics:m,quad:cdpQuadToRootViewport(box.model?.content,m.scale,rootMetrics.scale)};
    };
    const measure=()=>verifyFramePoint({x:initial.x,y:initial.y},{frameId:target.frameId,documentEpoch:target.loaderId!,
      rootId:root.frameId,rootDocumentEpoch:root.loaderId!,depth:owners.length},{
      readBoundary:async index=>{
        const rootNow=await metrics(owners.length-1);
        if(JSON.stringify(rootNow)!==JSON.stringify(rootMetrics))stale();
        const current=await sample(index);let contentQuad=current.quad;
        if(index+1<owners.length){
          const parent=await sample(index+1),quad:number[]=[];
          if(JSON.stringify(current.metrics.parentViewport)!==JSON.stringify(parent.metrics.viewport))stale();
          for(let i=0;i<8;i+=2){
            const local=parentPointToFrame({x:contentQuad[i]!,y:contentQuad[i+1]!},parent.metrics.viewport,parent.quad);
            quad.push(local.x,local.y);
          }
          contentQuad=quad as unknown as FrameQuad;
        }
        return {frameId:ancestry[index]!.frameId,documentEpoch:ancestry[index]!.loaderId!,
          parentId:ancestry[index+1]!.frameId,parentDocumentEpoch:ancestry[index+1]!.loaderId!,
          viewport:current.metrics.viewport,parentViewport:current.metrics.parentViewport,contentQuad};
      },
      hitOwner:async(index,point)=>await call(owners[index]!,frameBoundOwnerHitFunction,[point])===true
    },signal);
    const proof=await measure();
    const final=targetGeometry(await call(targetObject,frameTargetGeometryFunction,[proof.local]));
    if(JSON.stringify(final)!==JSON.stringify(initial))stale();
    const after=await graph.snapshot(signal);
    if(after.revision!==before.revision||JSON.stringify(after.frames)!==JSON.stringify(before.frames))stale();
    checkAbort(signal);
    if(use)await use({
      recheck:async()=>{
        if(JSON.stringify(await measure())!==JSON.stringify(proof))stale();
        if(JSON.stringify(targetGeometry(await call(targetObject,frameTargetGeometryFunction,[proof.local])))!==JSON.stringify(initial))stale();
        const current=await graph.snapshot(signal);
        if(current.revision!==before.revision||JSON.stringify(current.frames)!==JSON.stringify(before.frames))stale();
      },
      identity:async()=>{
        await scope.send('Accessibility.enable',{});
        return scope.send('Accessibility.getPartialAXTree',{backendNodeId:request.backendNodeId,fetchRelatives:false});
      },
      click:async()=>{
        await graph.dispatchFramePointer(before.revision,'mousePressed',proof.point,signal);
        await graph.dispatchFramePointer(before.revision,'mouseReleased',proof.point,signal);
      }
    });
    // No object/session/context IDs escape as a future input token. Reacquire
    // and rerun permission, leaf/ancestor checks and dispatch gates for input.
    result={point:proof.point,local:proof.local,depth:owners.length};
  } finally {await scope.close();}
  // Cleanup itself awaits browser/authority calls. A navigation or Stop there
  // must not publish a measurement from the outgoing document.
  const finalGraph=await graph.snapshot(signal);checkAbort(signal);
  if(finalGraph.revision!==before.revision||JSON.stringify(finalGraph.frames)!==JSON.stringify(before.frames))stale();
  return result;
}

export async function readFrameGeometry(graph:FrameSessions,raw:unknown,origin:string,signal:AbortSignal){
  return withBoundFrameGeometry(graph,raw,origin,signal);
}
