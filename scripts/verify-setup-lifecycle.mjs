// Exercise actual Cordis service activation and SlotRegistry declaration effects.
// A pure SlotCore fixture cannot model ctx.get's active-provider requirement.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const hostRoot=process.argv[2] ?? path.resolve(import.meta.dirname, '..');
const rendererRoot=process.argv[3] ?? hostRoot;
const hostRequire=createRequire(path.join(path.resolve(hostRoot),'package.json'));
const rendererRequire=createRequire(path.join(path.resolve(rendererRoot),'package.json'));
const cordis=await import(hostRequire.resolve('@deepseek-ai/cordis'));
const slots=await import(hostRequire.resolve('@deepseek-ai/dsh-client-ui-slots'));
const modules={react:hostRequire('react'),'react/jsx-runtime':hostRequire('react/jsx-runtime'),
  'react-dom':rendererRequire('react-dom'),'react-dom/client':rendererRequire('react-dom/client'),
  '@deepseek-ai/cordis':cordis,'@deepseek-ai/dsh-client-ui-slots':slots};
let rendererDefinition;
vm.runInNewContext(await readFile(path.join(path.dirname(hostRequire.resolve('@deepseek-ai/dsh-client-ui-renderer')),'client.js'),'utf8'),{
 window:{__ModuleLoader__:{load:d=>rendererDefinition=d}},console,queueMicrotask,setTimeout,clearTimeout,
});
const {SlotRegistry}=rendererDefinition.factory(name=>{if(!(name in modules))throw Error(name);return modules[name]});
let clientDefinition;
vm.runInNewContext(await readFile(new URL('../client.js',import.meta.url),'utf8'),{
 window:{__ModuleLoader__:{load:d=>clientDefinition=d},addEventListener(){},removeEventListener(){}},
 document:{visibilityState:'visible',hasFocus:()=>true,addEventListener(){},removeEventListener(){}},
 crypto:webcrypto,AbortController,AbortSignal,navigator:{language:'zh-CN'},console,setTimeout,clearTimeout,
});
const panel='dsh-native-browser.setup';
const declarations={main:{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'},
 'settings.section':{kind:'list',scope:'root'},'tool.call.toolview':{kind:'keyed',scope:'session'},
 'plugins.bundle.config':{kind:'keyed',scope:'root'},'plugins.row.config':{kind:'keyed',scope:'root'},
 'plugins.bundle.activation':{kind:'keyed',scope:'root'},'plugins.detail.actions':{kind:'list',scope:'root'}};
async function scenario(order){
 const ctx=new cordis.Context();await ctx.plugin(SlotRegistry);
 ctx.provide('sessions',{list:{getSnapshot:()=>({phase:'ready',byId:{}}),subscribe:()=>()=>{}}});
 ctx.provide('connection',{rpc:{call:async()=>({ok:true,value:{}})}});
 let duringActivation,layoutFiber,clientFiber;
 const addLayout=async()=>{
  layoutFiber=ctx.plugin({name:'layout-fixture',inject:['slots'],apply(owner){
   owner.provide('layout',{selectPanel(){}});
   duringActivation=ctx.get('layout');
   owner.slots.register({name:'root',children:declarations},()=>null);
  }});
  await layoutFiber;
 };
 const addClient=async()=>{clientFiber=ctx.plugin(clientDefinition.factory(name=>modules[name]));await clientFiber;};
 try{
  if(order==='cold'){await addClient();await addLayout();}else{await addLayout();await addClient();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(duringActivation,undefined,'Real Cordis hides a provider until its fiber activates');
  assert.ok(ctx.get('layout'),'Layout is available after boot');
  const main=()=>ctx.slots.entries('main').some(e=>e.options.key===panel);
  const nav=()=>ctx.slots.entries('sidebar.panellist').some(e=>e.options.id===panel);
  assert.ok(main(),`${order}: browser main panel missing`);
  assert.ok(nav(),`${order}: browser sidebar entry missing`);
  await layoutFiber.dispose();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(main(),false);assert.equal(nav(),false);
  await addLayout();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(main(),`${order}: main must recover after Layout reactivation`);
  assert.ok(nav(),`${order}: sidebar must recover after Layout reactivation`);
  await clientFiber.dispose();
  assert.equal(main(),false);assert.equal(nav(),false);
 }finally{await ctx.fiber.dispose();}
}
await scenario('cold');await scenario('warm');
console.log('Actual Cordis + SlotRegistry: cold/warm boot, Layout reactivation and plugin disposal passed.');
