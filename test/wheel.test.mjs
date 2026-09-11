import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserError } from '../dist/packages/contracts/src/index.js';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { wheelEvent, allowedMouseEvent } from '../dist/packages/provider-chromium/src/mouse.js';
import { ChromiumProvider } from '../dist/packages/provider-chromium/src/provider.js';
import { BrowserRuntime } from '../dist/packages/runtime-core/src/runtime.js';
import { acceptWelcome, negotiateHello, clientRequirements, brokerCapabilities, providerCapabilities } from '../dist/packages/contracts/src/wire.js';

const instance={id:'wheel-browser',family:'chromium',brand:'chrome',version:'test',profileLabel:'fixture',capabilities:{wheel:true}};
const signal=()=>new AbortController().signal;
const lease={id:'lease',owner:'owner',instanceId:instance.id,tab:'tab',token:'token',origin:'https://example.test',expiresAt:Date.now()+60000};
const request=(action,timeoutMs=1000)=>({requestId:'wheel-request',leaseId:lease.id,documentEpoch:'frame:loader',action,timeoutMs});
const action={kind:'wheel',ref:'target',deltaX:-120,deltaY:240,expected:{kind:'text',text:'Wheel complete'}};

function fixture() {
  const state={name:'Wheel region',covered:false,text:[],commands:[],wheel:[],onCall:undefined};
  const provider=new ChromiumProvider(instance,{async call(method,params){
    if(method==='tabs.list') return [{id:'tab',instanceId:instance.id,url:'https://example.test/',title:'Fixture'}];
    if(method==='ax.read') {method='cdp';params={method:'Accessibility.getFullAXTree',params:{}};}
    if(method!=='cdp') return {};
    const {method:command,params:p}=params; state.commands.push(command);
    if(command==='Input.dispatchMouseEvent') state.wheel.push(p);
    const custom=await state.onCall?.(command,p); if(custom!==undefined) return custom;
    if(command==='Page.getFrameTree') return {frameTree:{frame:{id:'frame',loaderId:'loader',url:'https://example.test/'}}};
    if(command.startsWith('Accessibility.')) return {nodes:[{backendDOMNodeId:30,role:{value:'region'},name:{value:state.name}},
      ...state.text.map(text=>({role:{value:'StaticText'},name:{value:text}}))]};
    if(command==='DOM.resolveNode') return {object:{objectId:'object-30'}};
    if(command==='Runtime.callFunctionOn') return {result:{value:{ok:!state.covered,connected:true,inViewport:true,x:50,y:60,left:0,top:0,width:100,height:120}}};
    if(command==='Input.dispatchMouseEvent') state.text=['Wheel complete'];
    return {};
  }});
  let dispatches=0;
  return {state,provider,execution:{signal:signal(),onDispatch(){dispatches++;}},dispatches:()=>dispatches};
}

test('wheel contract requires a ref and bounded nonzero deltas without coordinates, modifiers or value expectations',()=>{
  assert.deepEqual(actionRequest(request(action)).action,action);
  for(const patch of [{ref:undefined},{deltaX:0,deltaY:0},{deltaY:10001},{deltaY:1.5},{deltaY:'2'},
    {x:20},{modifiers:2},{expected:{kind:'value',value:'x'}}]) assert.throws(()=>actionRequest(request({...action,...patch})),{code:'INVALID_REQUEST'});
});

test('wheel capability must be present in both the Broker welcome and provider hello',()=>{
  assert.ok(clientRequirements.includes('runtime.wheel.v1'));
  assert.throws(()=>acceptWelcome({version:1,connectionEpoch:'c',capabilities:brokerCapabilities.filter(c=>c!=='runtime.wheel.v1')},clientRequirements),{code:'PROTOCOL_MISMATCH'});
  assert.throws(()=>negotiateHello({bootstrap:1,versions:[1],role:'provider',
    capabilities:providerCapabilities.filter(c=>c!=='input.wheel.v1'),
    instance:{id:'fixture',family:'chromium',brand:'chrome',version:'test',profileLabel:'fixture'}}),{code:'PROTOCOL_MISMATCH'});
});

test('mouse encoding allows only finite canonical left clicks and bounded unmodified wheel samples',()=>{
  const event=wheelEvent({x:1.5,y:20},{deltaX:-10000,deltaY:10000}); assert.equal(allowedMouseEvent(event),true);
  for(const patch of [{x:NaN},{y:Infinity},{x:-1},{deltaY:10001},{deltaY:0,deltaX:0},{deltaX:0.5},
    {modifiers:2},{buttons:1},{pointerType:'pen'},{type:'mouseMoved'},{timestamp:123}]) assert.equal(allowedMouseEvent({...event,...patch}),false);
  for(const type of ['mousePressed','mouseReleased']) {
    const click={type,x:2,y:3,button:'left',clickCount:1}; assert.equal(allowedMouseEvent(click),true);
    assert.equal(allowedMouseEvent({...click,button:'right'}),false); assert.equal(allowedMouseEvent({...click,clickCount:2}),false);
  }
  assert.throws(()=>wheelEvent({x:-1,y:0},{deltaX:1,deltaY:0}),{code:'INVALID_REQUEST'});
});

test('wheel on an observed region emits one sample, verifies feedback and does not click or focus',async()=>{
  const f=fixture(), o=await f.provider.observe(lease,f.execution.signal);
  const result=await f.provider.act(lease,request({...action,ref:o.nodes[0].id}),f.execution);
  assert.equal(result.postcondition,'passed'); assert.equal(f.dispatches(),1);
  assert.deepEqual(f.state.wheel,[wheelEvent({x:50,y:60},action)]);
  assert.equal(f.state.commands.includes('DOM.scrollIntoViewIfNeeded'),false);
  assert.equal(f.state.commands.includes('Input.dispatchKeyEvent'),false);
  assert.equal(f.state.commands.filter(c=>c==='Runtime.releaseObject').length,1);
});

test('covered, renamed, stale-point and cancelled wheel targets never dispatch',async()=>{
  for(const mode of ['covered','renamed','point','cancelled']) {
    const f=fixture(), o=await f.provider.observe(lease,f.execution.signal), controller=new AbortController();
    if(mode==='covered') f.state.covered=true;
    f.state.onCall=(command,p)=>{
      if(command!=='Runtime.callFunctionOn') return;
      if(mode==='renamed') f.state.name='Replaced';
      if(mode==='cancelled') controller.abort();
      if(mode==='point'&&p.arguments) return {result:{value:{ok:false,connected:true,inViewport:true}}};
    };
    const codes={covered:'DEADLINE_EXCEEDED',renamed:'STALE_TARGET',point:'NOT_ACTIONABLE',cancelled:'CANCELLED'};
    await assert.rejects(f.provider.act(lease,request({...action,ref:o.nodes[0].id},100),{...f.execution,signal:controller.signal}),{code:codes[mode]});
    assert.equal(f.state.wheel.length,0); assert.equal(f.dispatches(),0);
  }
});

test('missing wheel feedback does not trigger another sample',async()=>{
  const f=fixture(),o=await f.provider.observe(lease,f.execution.signal);
  f.state.onCall=command=>command==='Input.dispatchMouseEvent'?{}:undefined;
  await assert.rejects(f.provider.act(lease,request({...action,ref:o.nodes[0].id},120),f.execution),{code:'DEADLINE_EXCEEDED'});
  assert.equal(f.state.wheel.length,1);
});

test('wheel acknowledgement without a postcondition remains unknown; lost ack never replays',async()=>{
  for(const lost of [false,true]) {
    const f=fixture(),runtime=new BrowserRuntime(async()=>true); runtime.register(f.provider);
    if(lost) f.state.onCall=command=>{if(command==='Input.dispatchMouseEvent') throw new BrowserError('CONNECTION_LOST','Lost ack');};
    try {
      const l=await runtime.claim('owner',instance.id,'tab',signal());
      const o=await runtime.observe('owner',l.id,signal());
      const r={...request({kind:'wheel',ref:o.nodes[0].id,deltaX:0,deltaY:120}),leaseId:l.id};
      const result=await runtime.act('owner',r,signal()); assert.equal(result.outcome,'unknown'); assert.equal(result.postcondition,'unverified');
      if(lost) assert.equal(result.code,'CONNECTION_LOST');
      assert.deepEqual(await runtime.act('owner',r,signal()),result); assert.equal(f.state.wheel.length,1);
    } finally {await runtime.dispose();}
  }
});
