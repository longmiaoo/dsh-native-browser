import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {framePointToParent,parentPointToFrame,verifyFramePoint,frameOwnerHitFunction,cdpQuadToRootViewport} from '../dist/packages/provider-chromium/src/frame-geometry.js';
const signal=()=>new AbortController().signal;
const close=(a,b)=>{assert.ok(Math.abs(a.x-b.x)<1e-6,`${a.x} != ${b.x}`);assert.ok(Math.abs(a.y-b.y)<1e-6,`${a.y} != ${b.y}`);};
const viewport={width:300,height:200};
test('Chromium quad normalization uses measured relative document scale, not absolute DPR',()=>{
  const quad=[10,20,310,20,310,220,10,220];
  assert.deepEqual(cdpQuadToRootViewport(quad,2,2),quad);
  assert.deepEqual(cdpQuadToRootViewport(quad,2.3,2),quad.map(n=>n*1.15));
  assert.deepEqual(cdpQuadToRootViewport(quad,1.15,1),quad.map(n=>n*1.15));
  for(const scale of [0,-1,NaN,Infinity,100])assert.throws(()=>cdpQuadToRootViewport(quad,scale,2));
});
for(const [name,h] of [
  ['translation',[300,0,23,0,200,41,0,0]],['nonuniform scale',[600,0,23,0,100,41,0,0]],
  ['rotation',[240,-120,240,180,160,41,0,0]],['reflection',[-300,0,500,0,200,41,0,0]],
  ['skew',[300,70,23,45,200,41,0,0]],['perspective',[300,70,23,45,200,41,.35,-.1]]]){
  test(`frame content-quad projection and inverse preserve ${name}`,()=>{
    const map=(x,y)=>({x:(h[0]*x+h[1]*y+h[2])/(1+h[6]*x+h[7]*y),y:(h[3]*x+h[4]*y+h[5])/(1+h[6]*x+h[7]*y)});
    const quad=[[0,0],[1,0],[1,1],[0,1]].flatMap(([x,y])=>Object.values(map(x,y)));
    for(let i=1;i<20;i++){
      const p={x:viewport.width*i/21,y:viewport.height*(21-i)/22},parent=framePointToParent(p,viewport,quad);
      close(parent,map(p.x/viewport.width,p.y/viewport.height));close(parentPointToFrame(parent,viewport,quad),p);
    }
  });
}
test('invalid, concave, crossed, degenerate and nonfinite frame geometry cannot produce coordinates',()=>{
  for(const quad of [[],[0,0,100,0,100,100,0,NaN],[0,0,100,100,100,0,0,100],
    [0,0,100,0,30,30,0,100],[0,0,0,0,0,0,0,0],[0,0,1e9,0,1e9,100,0,100],
    [0,0,100,0,100,1e-15,0,1e-15]])assert.throws(()=>framePointToParent({x:20,y:20},viewport,quad),{code:'NOT_ACTIONABLE'});
  const quad=[0,0,300,0,300,200,0,200];
  for(const p of [{x:-1,y:10},{x:300,y:10},{x:10,y:200},{x:NaN,y:10}])assert.throws(()=>framePointToParent(p,viewport,quad));
  for(const width of [0,-1,Infinity,'300'])assert.throws(()=>framePointToParent({x:10,y:10},{width,height:200},quad));
});
function fixture(){
  const chain=[{frameId:'leaf',documentEpoch:'leaf-doc',parentId:'parent',parentDocumentEpoch:'parent-doc',viewport:{width:100,height:100},parentViewport:{width:300,height:300},contentQuad:[30,40,130,40,130,140,30,140]},
    {frameId:'parent',documentEpoch:'parent-doc',parentId:'root',parentDocumentEpoch:'root-doc',viewport:{width:300,height:300},parentViewport:{width:1000,height:800},contentQuad:[200,100,800,100,800,700,200,700]}];
  const hits=[],reads=[];
  return {chain,hits,reads,binding:{frameId:'leaf',documentEpoch:'leaf-doc',rootId:'root',rootDocumentEpoch:'root-doc',depth:2},
    source:{readBoundary:async index=>{reads.push(index);return chain[index];},hitOwner:async(index,p)=>{hits.push({index,p});return true;}}};
}
test('nested frame projection checks every bound owner twice without adding DPR or page scroll',async()=>{
  const f=fixture(),proof=await verifyFramePoint({x:20,y:30},f.binding,f.source,signal());close(proof.point,{x:300,y:240});
  assert.deepEqual(f.hits,[{index:0,p:{x:50,y:70}},{index:1,p:{x:300,y:240}},{index:0,p:{x:50,y:70}},{index:1,p:{x:300,y:240}}]);
  assert.deepEqual(f.reads,[0,1,0,1]);f.chain[0].contentQuad[0]=999;assert.equal(proof.chain[0].contentQuad[0],30);
});
test('caller mutations cannot retarget an in-flight point or change its reported local candidate',async()=>{
  const f=fixture(),local={x:20,y:30};
  f.source.readBoundary=async index=>{local.x=90;f.binding.rootId='different-root';f.binding.depth=32;return f.chain[index];};
  const proof=await verifyFramePoint(local,f.binding,f.source,signal());
  close(proof.point,{x:300,y:240});assert.deepEqual(proof.local,{x:20,y:30});
});
test('an overlay appearing during the final owner pass refuses the original candidate',async()=>{
  const f=fixture();let hits=0;f.source.hitOwner=async()=>++hits<4;
  await assert.rejects(verifyFramePoint({x:20,y:30},f.binding,f.source,signal()),{code:'NOT_ACTIONABLE'});
  assert.equal(hits,4);
});
test('parent overlays, clipping, viewport mismatch and wrong document chains refuse the point',async()=>{
  for(const mode of ['overlay','clipped','viewport','document','root','cycle','depth']){
    const f=fixture();if(mode==='overlay')f.source.hitOwner=async index=>index!==1;
    if(mode==='clipped')f.chain[0].parentViewport={width:40,height:300};
    if(mode==='viewport')f.chain[1].viewport.width=299;
    if(mode==='document')f.chain[1].documentEpoch='new';if(mode==='root')f.binding.rootId='other';
    if(mode==='cycle')f.chain[1].parentId='leaf';if(mode==='depth')f.binding.depth=33;
    await assert.rejects(verifyFramePoint({x:20,y:30},f.binding,f.source,signal()));
  }
});
test('a moved frame, even by a fractional pixel, invalidates the fixed candidate instead of substituting another',async()=>{
  const f=fixture();let reads=0;f.source.readBoundary=async index=>{
    if(++reads===3)f.chain[0].contentQuad[0]+=.01;return f.chain[index];
  };await assert.rejects(verifyFramePoint({x:20,y:30},f.binding,f.source,signal()),{code:'STALE_TARGET'});
  assert.equal(f.hits.length,2);
});
test('cancellation during boundary acquisition or a parent hit test prevents later checks',async()=>{
  for(const stage of ['read','hit']){
    const f=fixture(),controller=new AbortController();
    if(stage==='read')f.source.readBoundary=async index=>{controller.abort();return f.chain[index];};
    else f.source.hitOwner=async()=>{controller.abort();return true;};
    await assert.rejects(verifyFramePoint({x:20,y:30},f.binding,f.source,controller.signal));
  }
});
test('fixed owner hit test requires a connected iframe and rejects parent-document overlays',()=>{
  const owner={isConnected:true,tagName:'IFRAME',contentWindow:{},parentElement:null,tabIndex:-1,
    getBoundingClientRect:()=>({left:10,top:20,width:100,height:100}),getClientRects:()=>[{left:10,right:110,top:20,bottom:120}],
    getAttribute:()=>null,matches:()=>false,getRootNode:()=>({})};let hit=owner;
  const fn=vm.runInNewContext(`(${frameOwnerHitFunction})`,{innerWidth:800,innerHeight:600,document:{elementFromPoint:()=>hit},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'})});
  assert.equal(fn.call(owner,{x:50,y:60}),true);hit={...owner,contentWindow:null};assert.equal(fn.call(owner,{x:50,y:60}),false);
  owner.isConnected=false;assert.equal(fn.call(owner,{x:50,y:60}),false);
});
