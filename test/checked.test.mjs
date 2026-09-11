import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { checkedFunction, checkedValue } from '../dist/packages/provider-chromium/src/checked.js';
import { actionRequest } from '../dist/packages/contracts/src/validation.js';

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
