import { geometryFunction } from './actionability.js';
import { checkedFunction, checkedLabelFunction, checkedLabelBindingFunction, radioBindingFunction, radioBindingCheckFunction } from './checked.js';
import { editableFunction } from './editable.js';
import { elementStateFunction } from './element-state.js';
import { scrollByFunction, scrollStateFunction } from './scroll.js';
import { nativeTextFunction } from './text-input.js';

// Every function the Broker may run in a leased page's isolated world. The extension is the last
// line of defence, so it accepts nothing outside this fixed set (exact source match).
export const valueFunction = `function() {
  return {connected:this.isConnected,value:this.type!=='password'&&typeof this.value==='string'?this.value:null};
}`;
export const selectFunction = `function() {
  if (!this.isConnected || this.disabled || this.readOnly || this.type==='password' || !['INPUT','TEXTAREA'].includes(this.tagName))
    throw new Error('Input is no longer editable');
  this.focus({preventScroll:true});
  if (this.getRootNode().activeElement!==this) return {focused:false};
  this.select();
  return {focused:this.getRootNode().activeElement===this};
}`;
export const focusFunction = `function() {
  if (!this.isConnected || this.disabled || this.type==='password' || typeof this.focus!=='function')
    return {focused:false};
  this.focus({preventScroll:true});
  return {focused:this.getRootNode().activeElement===this};
}`;
export const focusStateFunction = `function() {
  return {connected:this.isConnected,focused:this.getRootNode().activeElement===this,
    disabled:!!this.disabled,readOnly:!!this.readOnly,type:this.type};
}`;
export const visualHitFunction = `function(x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return {ok:false};
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
  return {ok:true, connected:element.isConnected===true, disabled:element.disabled===true, tag:element.tagName,
    rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, pointerEvents:style.pointerEvents,
    visibility:style.visibility, opacity:style.opacity};
}`;

export const uploadInputFunction = 'function(){return this instanceof HTMLInputElement && this.type === "file" && this.isConnected === true && this.disabled === false;}';
export const nodeAttachedFunction = 'function(){return this.isConnected===true&&this.ownerDocument===document;}';

export const pageFunctions: ReadonlySet<string> = new Set([geometryFunction, checkedFunction, checkedLabelFunction,
  checkedLabelBindingFunction, radioBindingFunction, radioBindingCheckFunction, editableFunction, elementStateFunction,
  scrollByFunction, scrollStateFunction, nativeTextFunction, valueFunction, selectFunction, focusFunction, focusStateFunction,
  visualHitFunction, uploadInputFunction, nodeAttachedFunction]);
