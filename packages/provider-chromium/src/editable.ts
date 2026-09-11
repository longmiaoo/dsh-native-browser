/** Logical editing text for the bounded inline/DIV/P/BR structures Chromium emits.
 * A terminal BR is a caret placeholder; block boundaries delimit editing lines.
 * This is not arbitrary HTML-to-text or CSS rendered-text extraction. */
export function editableText(root: Node): string | null {
  let visited = 0;
  const read = (parent: Node, depth: number): string | null => {
    if (depth > 64) return null;
    let value = '', previousBlock = false, seen = false;
    for (let index = 0; index < parent.childNodes.length; index++) {
      const node = parent.childNodes[index]!;
      if (++visited > 4096) return null;
      if (node.nodeType === 8) continue;
      let part: string | null, block = false;
      if (node.nodeType === 3) part = node.nodeValue ?? '';
      else if (node.nodeType === 1) {
        const tag = (node as Element).tagName;
        if (tag === 'BR') part = node === parent.lastChild ? '' : '\n';
        else {
          block = tag === 'DIV' || tag === 'P';
          if (!block && !['SPAN', 'B', 'I', 'STRONG', 'EM', 'U', 'S', 'A', 'FONT', 'CODE', 'STRIKE', 'SUB', 'SUP'].includes(tag)) return null;
          part = read(node, depth + 1);
        }
      } else return null;
      if (part === null) return null;
      if (seen && (previousBlock || block && !value.endsWith('\n'))) value += '\n';
      value += part;
      if (value.length > 10000) return null;
      previousBlock = block; seen = true;
    }
    return value;
  };
  return read(root, 0);
}

/** Fixed renderer program, never model-supplied JavaScript. Text is inserted by CDP,
 * not by assigning innerHTML/textContent or dispatching synthetic input events. */
export const editableFunction = `function(mode) {
  const element=this, doc=this.ownerDocument, root=this.getRootNode();
  const parent=node=>node.assignedSlot || node.parentElement || node.getRootNode().host;
  const inspect=()=>{
    if(!element.isConnected) return {connected:false,editable:false};
    if(!element.isContentEditable || element.parentElement?.isContentEditable
      || !['true','plaintext-only'].includes(element.contentEditable)) return {connected:true,editable:false};
    let ancestor=element;
    for(let depth=0;ancestor&&depth<64;depth++,ancestor=parent(ancestor)) {
      if(ancestor.inert || ancestor.getAttribute('aria-readonly')==='true'
        || ancestor.getAttribute('aria-disabled')==='true') return {connected:true,editable:false};
    }
    if(ancestor) return {connected:true,editable:false};
    // Refuse partial/protected editors and bound inspection before selecting all.
    const walker=doc.createTreeWalker(element,NodeFilter.SHOW_ALL);
    let node, count=0, characters=0;
    while(node=walker.nextNode()) {
      if(++count>4096) return {connected:true,editable:false};
      if(node.nodeType===Node.TEXT_NODE && (characters+=node.data.length)>100000) return {connected:true,editable:false};
      if(node.nodeType===Node.ELEMENT_NODE && (node.shadowRoot || node.inert
        || node.matches('input,textarea,select,button,iframe,object,embed,[contenteditable], [aria-readonly="true"], [aria-disabled="true"]')))
        return {connected:true,editable:false};
    }
    return {connected:true,editable:true,focused:root.activeElement===element};
  };
  let state=inspect();
  if(!state.editable) return state;
  const selection=()=>typeof root.getSelection==='function'?root.getSelection():doc.getSelection();
  const append=mode==='append-end'||mode==='append-position';
  if(mode==='select'||mode==='append-end') {
    element.focus({preventScroll:true});
    state=inspect();
    if(!state.editable || !state.focused) return {...state,selected:false};
    const range=doc.createRange(); range.selectNodeContents(element);
    if(append) range.collapse(false);
    const selected=selection(); if(!selected) return {...state,selected:false};
    selected.removeAllRanges(); selected.addRange(range);
  }
  if(mode==='select'||mode==='selection'||append) {
    state=inspect();
    const selected=selection(), range=selected?.rangeCount===1?selected.getRangeAt(0):null;
    // Chrome can normalize shadow-root ranges to the first/last text leaf.
    // Accept equivalent outer edges, never merely matching selected text.
    const edge=(node,offset,end)=>{
      if(offset!==(end?(node.nodeType===Node.TEXT_NODE?node.length:node.childNodes.length):0)) return false;
      for(let depth=0;node&&depth<64;depth++) {
        if(node===element) return true;
        const parent=node.parentNode;
        if(!parent || node!==(end?parent.lastChild:parent.firstChild)) return false;
        node=parent;
      }
      return false;
    };
    if(append) return {...state,value:(${editableText.toString()})(element),
      atEnd:!!state.focused&&!!range&&range.collapsed&&edge(range.endContainer,range.endOffset,true)};
    return {...state,selected:!!state.focused&&!!range&&edge(range.startContainer,range.startOffset,false)
      &&edge(range.endContainer,range.endOffset,true)};
  }
  if(mode==='value') {
    const value=(${editableText.toString()})(element);
    return {...state,value};
  }
  return state;
}`;
