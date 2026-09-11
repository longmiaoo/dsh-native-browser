export function checkedValue(value: unknown): boolean | 'mixed' | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (value === 'mixed') return 'mixed';
}

// Read only: never assign checked/aria-checked or synthesize change/click events.
export const checkedFunction = `function() {
  if (!this.isConnected) return {connected:false};
  if (this.tagName==='INPUT' && this.type==='checkbox')
    return {connected:true,checked:this.indeterminate?'mixed':this.checked};
  if (this.tagName==='INPUT' && this.type==='radio')
    return {connected:true,checked:this.checked,nativeRadio:true};
  const role=this.getAttribute('role');
  if (role!=='checkbox' && role!=='switch') return {connected:true,supported:false};
  const value=this.getAttribute('aria-checked');
  return {connected:true,checked:value==='true'?true:value==='false'?false:role==='checkbox'&&value==='mixed'?'mixed':null};
}`;

// A label is an alternate pointer surface, never a replacement semantic target.
// Ignore input opacity/geometry (the reason to use a label), but preserve disabled
// and inert semantics even when the label is outside the input's ancestor tree.
const labelEligibleFunction = `function(input) {
  if (!input || !input.isConnected || input.tagName!=='INPUT' || !['checkbox','radio'].includes(input.type) || input.matches(':disabled')) return false;
  let node=input;
  for(let depth=0;node&&depth<64;depth++,node=node.assignedSlot||node.parentElement||node.getRootNode().host)
    if(node.inert || node.getAttribute('aria-disabled')==='true') return false;
  return !node;
}`;

export const checkedLabelFunction = `function() {
  if (!(${labelEligibleFunction})(this)) return null;
  const labels=this.labels;
  if (!labels || labels.length!==1) return null;
  const label=labels[0];
  return label.isConnected && label.control===this ? label : null;
}`;

export const checkedLabelBindingFunction = `function(input) {
  return this.isConnected && this.tagName==='LABEL' && (${labelEligibleFunction})(input)
    && this.control===input && input.labels.length===1 && input.labels[0]===this;
}`;

// Retain actual tree/form identities within one action, not mutable IDs or selectors.
// Browser-owned radio grouping remains native; never enumerate or modify peers.
export const radioBindingFunction = `function() {
  if (!this.isConnected || this.tagName!=='INPUT' || this.type!=='radio') return null;
  return {input:this,root:this.getRootNode(),form:this.form,name:this.name,value:this.value};
}`;

export const radioBindingCheckFunction = `function(binding) {
  return this.isConnected && this.tagName==='INPUT' && this.type==='radio' && !!binding
    && binding.input===this && binding.root===this.getRootNode() && binding.form===this.form
    && binding.name===this.name && binding.value===this.value;
}`;
