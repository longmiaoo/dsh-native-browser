import assert from 'node:assert/strict';

/** Hold only the completion of real Host storage/read calls. Browser capture,
 * native transport, Stop, DSH approval and canonical image storage remain real.
 */
export async function verifyScreenshotPublication({attachments,call,value,popupCommand,eventually,lease,instanceId,tabId}) {
  const passed=[];
  for(const stage of ['save','read']) {
    const save=attachments.saveImage,read=attachments.readImage;
    let enter,finish,readSignal,reads=0;
    const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{finish=resolve;});
    attachments.saveImage=async function(...args) {
      const result=await Reflect.apply(save,this,args);
      if(stage==='save') {enter();await held;}
      return result;
    };
    attachments.readImage=async function(...args) {
      reads++;readSignal=args[1];
      const result=await Reflect.apply(read,this,args);
      if(stage==='read') {enter();await held;}
      return result;
    };
    try {
      const pending=call('browser_screenshot',{leaseId:lease.id});
      await Promise.race([entered,pending.then(result=>{throw new Error(`Screenshot ended before Host hold: ${JSON.stringify(result.content)}`);})]);
      if(stage==='save') await value('browser_handoff',{leaseId:lease.id});
      else {
        await popupCommand('stop');
        await eventually(async()=>readSignal?.aborted===true,'Broker revocation event cancels the Host read signal');
      }
      finish();const result=await pending;
      assert.equal(result.isError,true);assert.equal(result.value,undefined);
      assert.ok(result.content.every(block=>block.type!=='image'));
      if(stage==='save') assert.equal(reads,0,'Handoff must prevent subsequent canonical read');
      passed.push(stage==='save'
        ? 'Handoff while real Host storage completes prevents canonical read and late DSH image publication'
        : 'Actual popup Stop propagates a scoped Broker event into Host read cancellation and returns no image');
    } finally {finish();attachments.saveImage=save;attachments.readImage=read;}
    await popupCommand('allow');
    lease=await value('browser_claim',{instanceId,tab:tabId});
  }
  const fresh=await call('browser_screenshot',{leaseId:lease.id});
  assert.equal(fresh.isError,false,JSON.stringify(fresh.content));
  assert.ok(fresh.content.some(block=>block.type==='image'));
  assert.equal(fresh.value.screenshot.leaseId,lease.id);
  passed.push('Fresh explicit consent and lease permit a new screenshot after cancelled publications');
  return {lease,passed};
}
