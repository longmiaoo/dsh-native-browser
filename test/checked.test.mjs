import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { checkedFunction, checkedValue, checkedLabelFunction, checkedLabelBindingFunction, radioBindingFunction, radioBindingCheckFunction } from '../dist/packages/provider-chromium/src/checked.js';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';
import { providerCapabilities, brokerCapabilities, clientRequirements, negotiateHello, acceptWelcome } from '../dist/packages/contracts/src/wire.js';

test('radio selection requires matching provider and Broker capability negotiation', () => {
  assert.ok(providerCapabilities.includes('input.radio.v1'));assert.ok(clientRequirements.includes('runtime.radio.v1'));
  assert.throws(()=>negotiateHello({bootstrap:1,versions:[1],role:'provider',
    capabilities:providerCapabilities.filter(c=>c!=='input.radio.v1'),
    instance:{id:'radio-test',family:'chromium',brand:'chrome',version:'test',profileLabel:'test'}}),{code:'PROTOCOL_MISMATCH'});
  assert.throws(()=>acceptWelcome({version:1,connectionEpoch:'radio-test',
    capabilities:brokerCapabilities.filter(c=>c!=='runtime.radio.v1')},clientRequirements),{code:'PROTOCOL_MISMATCH'});
});

test('checked state parsing preserves false and mixed without coercing arbitrary values', () => {
  for (const [input, output] of [[true,true],['true',true],[false,false],['false',false],['mixed','mixed'],[1,undefined],['yes',undefined],[{},undefined]]) assert.equal(checkedValue(input), output);
  const read = vm.runInNewContext(`(${checkedFunction})`);
  assert.equal(read.call({ isConnected:true, tagName:'INPUT', type:'checkbox', checked:false, indeterminate:true }).checked, 'mixed');
  assert.equal(read.call({ isConnected:true, tagName:'BUTTON', getAttribute:name=>name==='role'?'switch':'false' }).checked, false);
  assert.equal(read.call({ isConnected:false }).connected, false);
});

test('check contract requires a boolean and does not confuse checked state with input value', () => {
  const base = { requestId:'r',leaseId:'l',documentEpoch:'d',action:{kind:'check',ref:'n',checked:false} };
  assert.equal(actionRequest(base).action.checked, false);
  for (const action of [{kind:'check',ref:'n',checked:'false'}, {kind:'check',ref:'n'}, {...base.action, selector:'*'},
    {...base.action,expected:{kind:'value',value:'on'}}]) assert.throws(()=>actionRequest({...base,action}),{code:'INVALID_REQUEST'});
});

test('label surface is an exact sole native association, never a parent or text guess', () => {
  const resolve = vm.runInNewContext(`(${checkedLabelFunction})`);
  const bound = vm.runInNewContext(`(${checkedLabelBindingFunction})`);
  const input = {isConnected:true,tagName:'INPUT',type:'checkbox',matches:()=>false,getAttribute:()=>null,getRootNode:()=>({})};
  const label = {isConnected:true,tagName:'LABEL',control:input}; input.labels=[label];
  assert.equal(resolve.call(input),label); assert.equal(bound.call(label,input),true);
  input.labels.push({...label}); assert.equal(resolve.call(input),null); assert.equal(bound.call(label,input),false);
  input.labels=[label]; label.control={...input}; assert.equal(resolve.call(input),null); assert.equal(bound.call(label,input),false);
  label.control=input; label.isConnected=false; assert.equal(resolve.call(input),null);
  label.isConnected=true; input.type='radio'; assert.equal(resolve.call(input),label);
  input.type='text'; assert.equal(resolve.call(input),null);
});

test('native radio state ignores checkbox indeterminate and custom radio is unsupported', () => {
  const read=vm.runInNewContext(`(${checkedFunction})`);
  const state=read.call({isConnected:true,tagName:'INPUT',type:'radio',checked:true,indeterminate:true});
  assert.equal(state.checked,true); assert.equal(state.nativeRadio,true);
  assert.equal(read.call({isConnected:true,tagName:'DIV',getAttribute:key=>key==='role'?'radio':'true'}).supported,false);
});

test('radio binding retains exact form/tree/input identities and name/value within an action', () => {
  const capture=vm.runInNewContext(`(${radioBindingFunction})`), verify=vm.runInNewContext(`(${radioBindingCheckFunction})`);
  const root={}, form={}, input={isConnected:true,tagName:'INPUT',type:'radio',getRootNode:()=>root,form,name:'choice',value:'a'};
  const binding=capture.call(input); assert.equal(verify.call(input,binding),true);
  for(const patch of [{isConnected:false},{type:'checkbox'},{name:'new-group'},{value:'b'},{form:{}},{getRootNode:()=>({})}]) {
    const original={...input}; Object.assign(input,patch); assert.equal(verify.call(input,binding),false); Object.assign(input,original);
  }
  assert.equal(verify.call({...input},binding),false);
  assert.equal(capture.call({...input,type:'checkbox'}),null);
});

test('external label cannot bypass disabled, inert or aria-disabled input ancestry', () => {
  const resolve = vm.runInNewContext(`(${checkedLabelFunction})`);
  const bound = vm.runInNewContext(`(${checkedLabelBindingFunction})`);
  const input = {isConnected:true,tagName:'INPUT',type:'checkbox',matches:()=>false,getAttribute:()=>null,getRootNode:()=>({})};
  const label = {isConnected:true,tagName:'LABEL',control:input}; input.labels=[label];
  for (const ancestor of [{inert:true}, {getAttribute:()=> 'true'}]) {
    input.parentElement={getAttribute:()=>null,...ancestor};
    assert.equal(resolve.call(input),null); assert.equal(bound.call(label,input),false);
  }
  input.parentElement=null; input.matches=()=>true;
  assert.equal(resolve.call(input),null); assert.equal(bound.call(label,input),false);
  input.matches=()=>false; input.parentElement=input;
  assert.equal(resolve.call(input),null); // Bounded ancestor traversal.
});
