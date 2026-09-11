/** Append's fixed native-control program. It moves only the caret, never assigns
 * value, selects the old text, or dispatches DOM events. */
export const nativeTextFunction = `function(mode) {
  const inspect=()=>{
    if(!this.isConnected) return {connected:false,editable:false};
    if(!(this.tagName==='TEXTAREA'||this.tagName==='INPUT'&&['text','search','url','tel'].includes(this.type))
      ||this.readOnly||this.matches(':disabled')) return {connected:true,editable:false};
    let parent=this;
    for(let depth=0;parent&&depth<64;depth++,parent=parent.assignedSlot||parent.parentElement||parent.getRootNode().host)
      if(parent.inert||parent.getAttribute('aria-disabled')==='true'||parent.getAttribute('aria-readonly')==='true')
        return {connected:true,editable:false};
    if(parent||typeof this.value!=='string'||this.value.length>10000) return {connected:true,editable:false};
    return {connected:true,editable:true,value:this.value,maxLength:this.maxLength,singleLine:this.tagName==='INPUT',
      atEnd:this.getRootNode().activeElement===this&&this.selectionStart===this.value.length&&this.selectionEnd===this.value.length};
  };
  let state=inspect();
  if(mode==='end'&&state.editable) {
    this.focus({preventScroll:true}); state=inspect();
    if(!state.editable||this.getRootNode().activeElement!==this) return {...state,atEnd:false};
    this.setSelectionRange(this.value.length,this.value.length);
    state=inspect();
  }
  return state;
}`;
