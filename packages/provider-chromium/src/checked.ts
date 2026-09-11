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
  const role=this.getAttribute('role');
  if (role!=='checkbox' && role!=='switch') return {connected:true,supported:false};
  const value=this.getAttribute('aria-checked');
  return {connected:true,checked:value==='true'?true:value==='false'?false:role==='checkbox'&&value==='mixed'?'mixed':null};
}`;
