import { BrowserError } from '../../contracts/src/index.js';
import { record, string } from '../../contracts/src/validation.js';
import type { FrameSessions } from './frame-sessions.js';
import { frameGeometryRequest, withBoundFrameGeometry } from './frame-geometry-read.js';

const roles=new Set(['button','link','textbox','combobox','checkbox','radio','tab','menuitem','switch']);
export function frameClickRequest(raw:unknown){
  const v=record(raw);
  if(Object.keys(v).some(key=>!['binding','backendNodeId','role','name'].includes(key))
    ||!roles.has(string(v.role,80))||typeof v.name!=='string'||v.name.length>1000)
    throw new BrowserError('INVALID_REQUEST','Invalid bound child click target');
  return {...frameGeometryRequest({binding:v.binding,backendNodeId:v.backendNodeId}),role:v.role as string,name:v.name};
}

/** prepare and dispatch share all checks, but only the dispatch command enables
 * the input callback. No point/object/session token crosses the bridge. */
export async function frameClick(graph:FrameSessions,raw:unknown,origin:string,signal:AbortSignal,dispatch:boolean){
  const request=frameClickRequest(raw);
  await withBoundFrameGeometry(graph,{binding:request.binding,backendNodeId:request.backendNodeId},origin,signal,async bound=>{
    const identity=async()=>{
      const response=await bound.identity();
      const node=response.nodes?.find((n:Record<string,any>)=>n.backendDOMNodeId===request.backendNodeId);
      if(!node||node.ignored||node.role?.value!==request.role||(node.name?.value??'')!==request.name)
        throw new BrowserError('STALE_TARGET','Child target semantic identity changed');
      if(node.properties?.some((p:Record<string,any>)=>p.name==='disabled'&&p.value?.value===true))
        throw new BrowserError('NOT_ACTIONABLE','Child target is disabled');
    };
    await identity();await bound.recheck();await identity();
    if(dispatch){await bound.recheck();await bound.click();}
  });
  return {acknowledged:dispatch};
}
