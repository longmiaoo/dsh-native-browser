import { BrowserError, type BrowserKey } from '../../contracts/src/index.js';

// Browser-specific event encoding shared by the provider and its last-mile gate.
// No arbitrary text, editing commands, system shortcuts, held keys or auto-repeat.
const definitions: Record<BrowserKey, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
};

export function keyEvent(key: BrowserKey, shift: boolean, type: 'keyDown' | 'keyUp'): Record<string, string | number> {
  if (typeof key !== 'string' || !Object.hasOwn(definitions, key) || typeof shift !== 'boolean' || !['keyDown', 'keyUp'].includes(type)) {
    throw new BrowserError('INVALID_REQUEST', 'Unsupported keyboard event');
  }
  const definition = definitions[key];
  return { type, key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.vk,
    modifiers: shift ? 8 : 0, ...(type === 'keyDown' && definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}) };
}

/** Exact shape: forbids commands, Ctrl/Alt/Meta, arbitrary text and mismatched key codes. */
export function allowedKeyEvent(params: Record<string, unknown>): boolean {
  if (params.type !== 'keyDown' && params.type !== 'keyUp' || params.modifiers !== 0 && params.modifiers !== 8) return false;
  const key = params.key === ' ' ? 'Space' : params.key;
  if (typeof key !== 'string' || !Object.hasOwn(definitions, key)) return false;
  const expected = keyEvent(key as BrowserKey, params.modifiers === 8, params.type);
  return Object.keys(params).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => params[key] === value);
}
