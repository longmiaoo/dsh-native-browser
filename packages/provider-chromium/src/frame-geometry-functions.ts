import { geometryFunction } from './actionability.js';
import { frameOwnerHitFunction } from './frame-geometry.js';

// Fixed read-only functions. Resolving a backend ID in a chosen context is not
// proof that the underlying node belongs to that document: check ownership too.
export const frameTargetGeometryFunction = `function(point) {
  if(this.ownerDocument!==document) return {ok:false};
  return (${geometryFunction}).call(this,point);
}`;
export const frameBoundOwnerHitFunction = `function(point) {
  return this.ownerDocument===document && (${frameOwnerHitFunction}).call(this,point);
}`;
export const frameOwnerMetricsFunction = `function() {
  if(this.ownerDocument!==document||!this.isConnected||this.tagName!=='IFRAME'||!this.contentWindow) return null;
  return {viewport:{width:this.contentWindow.innerWidth,height:this.contentWindow.innerHeight},
    parentViewport:{width:innerWidth,height:innerHeight},scale:devicePixelRatio};
}`;
export const frameGeometryFunctions = new Set([frameTargetGeometryFunction,frameBoundOwnerHitFunction,frameOwnerMetricsFunction]);
