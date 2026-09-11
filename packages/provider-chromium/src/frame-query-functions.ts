// Fixed, read-only document ownership checks. No caller-supplied source or args.
export const frameQueryDocumentFunction = 'function(){return this===document;}';
export const frameQueryNodeFunction = 'function(){return this.isConnected===true&&this.ownerDocument===document;}';
export const frameWithinRootFunction = `function(root){
  if(!this.isConnected||this.ownerDocument!==document||!root||!root.isConnected
    ||root!==document&&root.ownerDocument!==document)return false;
  let node=this;
  for(let depth=0;node&&depth<256;depth++){
    if(node===root)return true;
    node=node.assignedSlot||node.parentNode||(node.nodeType===11?node.host:null);
  }
  return false;
}`;
export const frameQueryFunctions = new Set([frameQueryDocumentFunction, frameQueryNodeFunction, frameWithinRootFunction]);
