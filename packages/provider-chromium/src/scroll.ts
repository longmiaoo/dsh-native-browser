import { BrowserError, type ScrollPosition } from '../../contracts/src/index.js';
import { scrollPosition } from '../../contracts/src/scrolling.js';

// Fixed target-relative DOM operation, never model-supplied JavaScript or a pointer guess.
export const scrollStateFunction = `function() {
  const element=this.nodeType===9?this.scrollingElement:this;
  if (!element || !element.isConnected) return {connected:false};
  return {connected:true,canScroll:typeof element.scrollBy==='function',
    x:element.scrollLeft,y:element.scrollTop,scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight,
    clientWidth:element.clientWidth,clientHeight:element.clientHeight};
}`;
export const scrollByFunction = `function(deltaX, deltaY) {
  const element=this.nodeType===9?this.scrollingElement:this;
  if (!element || !element.isConnected || typeof element.scrollBy!=='function') throw new Error('Scroll target is unavailable');
  element.scrollBy({left:deltaX,top:deltaY,behavior:'instant'});
}`;

export function checkedScrollPosition(result: Record<string, any>): ScrollPosition {
  const value = result.result?.value;
  if (result.exceptionDetails || value?.connected !== true) throw new BrowserError('STALE_TARGET', 'Scroll target was removed');
  if (value.canScroll !== true) throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Target does not support DOM scrolling');
  const position = scrollPosition(value);
  if (position.clientWidth < 1 || position.clientHeight < 1) throw new BrowserError('NOT_ACTIONABLE', 'Scroll target has no rendered viewport');
  return position;
}

export function sameScrollPosition(a: ScrollPosition, b: ScrollPosition): boolean {
  return (['x', 'y', 'scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'] as const)
    .every(key => Math.abs(a[key] - b[key]) <= 0.5);
}
