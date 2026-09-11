// Fixed renderer function. Bounded fragment/point/composed-tree search, no model JavaScript.
export const geometryFunction = `function(preferred) {
  if (!this.isConnected) return {ok:false,connected:false};
  const r=this.getBoundingClientRect(), style=getComputedStyle(this);
  const base={ok:false,connected:true,inViewport:false,x:r.left+r.width/2,y:r.top+r.height/2,
    left:r.left,top:r.top,width:r.width,height:r.height,tag:this.tagName,readOnly:!!this.readOnly,type:this.type};
  const parent=node=>node.assignedSlot || node.parentElement || node.getRootNode().host;
  let clip={left:0,top:0,right:innerWidth,bottom:innerHeight}, ancestor=this;
  let allowed=r.width>0&&r.height>0&&style.visibility==='visible'&&!this.matches(':disabled');
  for(let depth=0;ancestor&&depth<64;depth++,ancestor=parent(ancestor)) {
    const s=getComputedStyle(ancestor);
    if(s.display==='none'||Number(s.opacity)<=0||ancestor.inert||ancestor.getAttribute('aria-disabled')==='true') allowed=false;
    if(ancestor!==this) {
      const a=ancestor.getBoundingClientRect();
      if(/^(auto|scroll|hidden|clip)$/.test(s.overflowX)) {clip.left=Math.max(clip.left,a.left);clip.right=Math.min(clip.right,a.right);}
      if(/^(auto|scroll|hidden|clip)$/.test(s.overflowY)) {clip.top=Math.max(clip.top,a.top);clip.bottom=Math.min(clip.bottom,a.bottom);}
    }
  }
  if(ancestor) return base;
  const independent=node=>node.matches('button,input,select,textarea,a[href],summary,[contenteditable]:not([contenteditable="false"])')
    || node.tabIndex>=0 || /^(button|link|textbox|combobox|checkbox|radio|tab|menuitem|menuitemcheckbox|menuitemradio|switch|slider|spinbutton|treeitem|option)$/.test(node.getAttribute('role')||'');
  const ownsPoint=(x,y)=>{
    let hit=document.elementFromPoint(x,y);
    let shadowDepth=0;
    for(;hit&&hit.shadowRoot&&shadowDepth<16;shadowDepth++) {
      const deeper=hit.shadowRoot.elementFromPoint(x,y);
      if(!deeper||deeper===hit) break;
      hit=deeper;
    }
    if(shadowDepth===16&&hit&&hit.shadowRoot) return false;
    for(let depth=0;hit&&depth<64;depth++,hit=parent(hit)) {
      if(hit===this) return true;
      if(independent(hit)) return false;
    }
    return false;
  };
  const rects=this.getClientRects(), visible=[];
  for(let i=0;i<Math.min(rects.length,16);i++) {
    const box=rects[i], left=Math.max(box.left,clip.left), right=Math.min(box.right,clip.right),
      top=Math.max(box.top,clip.top), bottom=Math.min(box.bottom,clip.bottom);
    if(right>left&&bottom>top) visible.push({left,right,top,bottom,area:(right-left)*(bottom-top)});
  }
  base.inViewport=visible.length>0;
  if(!allowed) return base;
  visible.sort((a,b)=>b.area-a.area);
  if(preferred) {
    const {x,y}=preferred;
    if(Number.isFinite(x)&&Number.isFinite(y)&&visible.some(b=>x>=b.left&&x<b.right&&y>=b.top&&y<b.bottom)&&ownsPoint(x,y))
      return {...base,ok:true,x,y};
    return base;
  }
  for(const box of visible) for(const [fx,fy] of [[.5,.5],[.15,.5],[.85,.5],[.5,.15],[.5,.85],[.15,.15],[.85,.15],[.15,.85],[.85,.85]]) {
    const x=box.left+(box.right-box.left)*fx, y=box.top+(box.bottom-box.top)*fy;
    if(ownsPoint(x,y)) return {...base,ok:true,x,y};
  }
  return base;
}`;

export function sameGeometry(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ['x', 'y', 'left', 'top', 'width', 'height'].every(key =>
    typeof a[key] === 'number' && Number.isFinite(a[key]) && typeof b[key] === 'number' && Number.isFinite(b[key])
      && Math.abs((a[key] as number) - (b[key] as number)) <= 1);
}
