// Fixed, read-only predicate on an object retained BEFORE the action. No selectors,
// re-resolution by name, page strings/values, input or page-defined callback code.
export const elementStateFunction = `function(state) {
  const connected=this.isConnected===true, sameDocument=this.ownerDocument===document;
  const result={connected,sameDocument,supported:true,matched:false};
  if(!sameDocument) return result;
  if(state==='attached') return {...result,matched:connected};
  if(state==='detached') return {...result,matched:!connected};
  if(!connected) return {...result,matched:state==='hidden'};
  if(state==='visible'||state==='hidden') {
    const r=this.getBoundingClientRect(), s=getComputedStyle(this);
    const visible=r.width>0&&r.height>0&&s.visibility==='visible';
    return {...result,matched:state==='visible'?visible:!visible};
  }
  const role=this.getAttribute('role');
  if(state==='checked'||state==='unchecked') {
    let checked;
    if(this.tagName==='INPUT'&&['checkbox','radio'].includes(this.type))
      checked=this.type==='checkbox'&&this.indeterminate?'mixed':this.checked;
    else if(['checkbox','switch','radio'].includes(role)) {
      const value=this.getAttribute('aria-checked');
      checked=value==='true'?true:value==='false'?false:value==='mixed'?'mixed':undefined;
    }
    return {...result,supported:checked!==undefined,matched:checked===(state==='checked')};
  }
  if(state==='enabled'||state==='disabled') {
    if(!['BUTTON','INPUT','SELECT','TEXTAREA','OPTION','OPTGROUP','FIELDSET'].includes(this.tagName)
      && !/^(button|link|textbox|combobox|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|slider|spinbutton|treeitem|option)$/.test(role||''))
      return {...result,supported:false};
    let disabled=this.matches(':disabled'), node=this;
    for(let depth=0;node&&depth<64;depth++,node=node.assignedSlot||node.parentElement||node.getRootNode().host)
      if(node.inert||node.getAttribute('aria-disabled')==='true') disabled=true;
    if(node) return {...result,supported:false};
    return {...result,matched:state==='disabled'?disabled:!disabled};
  }
  return {...result,supported:false};
}`;
