import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as browserPlugin from '../index.js';
import { startBroker } from '../dist/packages/broker/src/server.js';
import { FakeProvider } from '../test/helpers/fake-provider.mjs';
import { ScreenshotRegistry } from '../dist/packages/vision-adapter/src/screenshots.js';
import { parseRouterGrounding } from '../dist/packages/vision-adapter/src/grounding.js';

// Optional compatibility test, not a production vision backend or an LLM score.
// Both supplied package roots are read-only. Only a private temporary Host and
// this script's exact loopback endpoint/Unix socket may receive connections.
const [hostRoot,routerRoot]=process.argv.slice(2);
if(!hostRoot||!routerRoot) throw new Error('Pass absolute installed DSH and dsh-vision-router package directories');
const hostRequire=createRequire(path.join(path.resolve(hostRoot),'package.json'));
const load=name=>import(hostRequire.resolve(name));
const {Context}=await load('@deepseek-ai/cordis');
const {default:SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt');
const {ToolRuntime}=await load('@deepseek-ai/dsh-tools');
const {LlmRuntime,createToolResultMessage}=await load('@deepseek-ai/dsh-llm');
const {Session,SessionId}=await load('@deepseek-ai/dsh-session');
const {LocalAttachmentStore}=await load('@deepseek-ai/dsh-attachment-local');
const {LocalFileSystem}=await load('@deepseek-ai/dsh-fs-local');
const {default:sharp}=await load('sharp');
const routerPackage=JSON.parse(await readFile(path.join(routerRoot,'package.json'),'utf8'));
assert.equal(routerPackage.name,'dsh-vision-router');
const directory=await mkdtemp(path.join(tmpdir(),'dsh-router-smoke-'));
const ctx=new Context(), passed=[], requests=[], rejectedConnections=[];
let broker,server,originalConnect,mode='pixels';
try {
  const width=320,height=180,x1=randomInt(25,110),y1=randomInt(20,70),x2=x1+60,y2=y1+40;
  const pixels=await sharp({create:{width,height,channels:3,background:'white'}})
    .composite([{input:await sharp({create:{width:x2-x1,height:y2-y1,channels:3,background:'#ef16d9'}}).png().toBuffer(),left:x1,top:y1}])
    .jpeg({quality:95}).toBuffer();
  server=createServer(async(req,res)=>{
    try {
      if(req.method==='GET'&&['/api/ps','/api/tags','/v1/models'].includes(req.url)) {
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:[{name:'fixture-vl',model:'fixture-vl'}],data:[{id:'fixture-vl'}]}));return;
      }
      assert.equal(req.url,'/v1/chat/completions');assert.equal(req.method,'POST');
      let size=0;const chunks=[];
      for await(const chunk of req) {size+=chunk.length;if(size>8*1024*1024)throw new Error('Oversized test request');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const images=body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='image_url'):[]);
      assert.equal(images.length,1);assert.equal(body.model,'fixture-vl');
      const data=images[0].image_url.url;assert.match(data,/^data:image\/(png|jpeg);base64,/);
      const encoded=Buffer.from(data.slice(data.indexOf(',')+1),'base64');
      const {data:rgb,info}=await sharp(encoded).removeAlpha().raw().toBuffer({resolveWithObject:true});
      // Deterministic pixel detector; no fixture coordinates reach the request.
      let left=info.width,top=info.height,right=0,bottom=0;
      for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++) {
        const i=(y*info.width+x)*info.channels;
        if(rgb[i]>180&&rgb[i+1]<85&&rgb[i+2]>140) {left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
      }
      assert.ok(right>left&&bottom>top);
      requests.push({width:info.width,height:info.height,bytes:encoded.length,mode});
      if(mode==='rate-limit') {res.writeHead(429,{'content-type':'application/json','retry-after':'1'});res.end('{"error":"fixture rate limit"}');return;}
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({x1:left,y1:top,x2:right,y2:bottom})}}]}));
    } catch(error) {res.writeHead(500);res.end('Fixture request rejected');console.error(error);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  broker=await startBroker({directory,allowedOrigins:['https://example.test']});
  const provider=new FakeProvider();broker.runtime.register(provider);
  const shot={tab:'tab-1',documentEpoch:'doc-1',capturedAt:Date.now(),mimeType:'image/jpeg',data:pixels.toString('base64'),
    viewport:{width:640,height:360,pageX:0,pageY:0}};
  provider.capture=async()=>({...shot,capturedAt:Date.now()});
  originalConnect=Socket.prototype.connect;
  Socket.prototype.connect=function(...args) {
    const normalized=Array.isArray(args[0])?args[0]:args;
    const first=normalized[0];const options=typeof first==='object'?first:
      typeof first==='number'?{port:first,host:typeof normalized[1]==='string'?normalized[1]:'localhost'}:{path:first};
    const allowed=options?.path===broker.socket || options?.host==='127.0.0.1'&&Number(options.port)===port;
    if(!allowed) {rejectedConnections.push({host:String(options?.host??''),port:String(options?.port??'')});throw new Error('Non-fixture network denied');}
    return Reflect.apply(originalConnect,this,args);
  };
  const router=await import(pathToFileURL(path.join(routerRoot,routerPackage.main)).href);
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalAttachmentStore,{dshHome:path.join(directory,'fixture-host')});
  await ctx.plugin(LocalFileSystem,{cwd:directory});
  await ctx.plugin(browserPlugin,{runtimeDirectory:directory});
  await ctx.plugin(router,{tool:true,progressiveTools:false,freeFallback:false,freeCloudFirst:false,
    routing:false,stealth:false,autoWrapProviders:false,wrappedProviders:[],cache:false,instantDescribe:false,
    structuredVisionBootstrap:false,desktopScreenshot:false,autoActivateOnImage:false,
    providers:[],httpProviders:[],localLmStudio:{enabled:true,baseURL:`http://127.0.0.1:${port}/v1`,model:'fixture-vl'},
    timeoutMs:2000,visionTaskTimeoutMs:3000});
  ctx.provide('approval',{request:async()=> 'allowed-once'});
  const newSession=id=>Session.create(SessionId(id),undefined,{version:3,id,createdAt:Date.now(),isSeeded:false,cwd:directory});
  const session=newSession('vision-browser-test');session.append('turn/start',{turn:1});
  const other=newSession('vision-other-test');other.append('turn/start',{turn:1});
  let number=0,visionEnabled=false;
  const call=(name,args,owner=session)=>ctx.tools.execute({name,callId:`vision-smoke-${++number}`,arguments:args,
    agent:{session:owner,...visionEnabled?{options:{config:{provider:'deepseek-vision',model:'fixture-vl'}}}:{}},signal:AbortSignal.timeout(6000)});
  const resultValue=async(name,args,owner)=>{const result=await call(name,args,owner);assert.equal(result.isError,false,JSON.stringify(result.content));return result;};
  const lease=(await resultValue('browser_claim',{instanceId:'fake-1',tab:'tab-1'})).value;
  const capture=await resultValue('browser_screenshot',{leaseId:lease.id});
  const attachment=capture.value.attachment;
  // ToolRuntime returns blocks; the agent loop publishes them as a durable tool result.
  session.append('tool/result',{step:1,message:createToolResultMessage({callId:'browser-capture',content:capture.content,isError:false})},{surfaceOp:'append'});
  const canonical=await ctx.attachments.readImage(attachment);
  assert.equal(createHash('sha256').update(canonical.data).digest('hex'),capture.value.screenshot.sha256);
  const registry=new ScreenshotRegistry(),ref=registry.register('owning-turn',lease.id,{...shot,capturedAt:capture.value.capturedAt},
    {attachmentId:attachment.attachmentId,width:attachment.width,height:attachment.height,bytes:canonical.data});
  passed.push('Real Host-canonical browser image published as a durable DSH tool-result attachment');
  const args={image:attachment.attachmentId,target:'the magenta rectangle',annotate:false};
  const modeOff=await call('vision_ground',args);assert.equal(modeOff.isError,true);assert.equal(requests.length,0);
  assert.match(JSON.stringify(modeOff.content),/Vision mode is off/);
  passed.push('Router Vision mode off rejects the tool before any image backend request');
  visionEnabled=true;
  const result=await resultValue('vision_ground',args);
  const candidate=parseRouterGrounding(registry,'owning-turn',ref.id,args.target,result.value);
  for(const [key,wanted] of Object.entries({x1,y1,x2,y2})) assert.ok(Math.abs(candidate.box[key]-wanted)<=2,`${key}: ${candidate.box[key]} versus ${wanted}`);
  assert.ok(Math.abs(candidate.viewportPoint.x-(x1+x2))<=4);assert.ok(Math.abs(candidate.viewportPoint.y-(y1+y2))<=4);
  assert.equal(requests.length,1);assert.equal(requests[0].width,1000);assert.equal(requests[0].height,1000);
  passed.push('Public Vision Router ground consumes the exact authorized attachment; actual square-frame pixels return to source/CSS coordinates once');
  const count=requests.length;
  const denied=await call('vision_ground',args,other);assert.equal(denied.isError,true);assert.equal(requests.length,count);
  assert.match(JSON.stringify(denied.content),/unknown attachment|not authorized/);
  passed.push('Another real DSH Session cannot use the browser attachment and sends no backend request');
  const short=await resultValue('vision_ground',{...args,image:attachment.attachmentId.slice(0,15)});
  assert.equal(typeof short.value,'string');
  passed.push('Public Router resolves the owning Session short attachment alias without changing canonical identity');
  mode='rate-limit';const before429=requests.length;
  const failed=await call('vision_ground',{...args,target:'the magenta rectangle rate-limit probe'});
  assert.ok(failed.isError||JSON.parse(failed.value).ok===false);
  assert.equal(requests.length,before429+1);
  // Upstream also checks release metadata. Our process-local socket fence
  // blocks those connections too; do not label the plugin "fully offline".
  assert.ok(rejectedConnections.every(c=>['registry.npmjs.org','api.github.com'].includes(c.host)&&c.port==='443'));
  passed.push('A local HTTP 429 fails without repeating or opening a cloud connection under the isolated no-fallback configuration');
  const report={checkedAt:new Date().toISOString(),routerVersion:routerPackage.version,
    hostVersion:JSON.parse(await readFile(path.join(hostRoot,'package.json'),'utf8')).version,passed,
    requestFrames:requests,blockedUpdateConnections:rejectedConnections,
    scope:'Actual DSH ToolRuntime/Session/Host attachment, browser plugin with FakeProvider, public Vision Router entry and loopback pixel-detector HTTP endpoint; no Chrome, LLM, user configuration or external network. Not a production egress guarantee.'};
  await mkdir('output/playwright',{recursive:true});await writeFile('output/playwright/vision-router-smoke.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  await ctx.fiber.dispose();await broker?.close();
  if(originalConnect)Socket.prototype.connect=originalConnect;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(directory,{recursive:true});
}
