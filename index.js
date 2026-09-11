/**
 * DSH bundle entry point.
 *
 * The project is intentionally capability-free during the pre-alpha protocol
 * phase. Keeping a valid Cordis entry lets us verify packaging and lifecycle
 * behavior without exposing browser tools whose safety contract is unfinished.
 */
export const name = 'dsh-native-browser'

export const projectStatus = Object.freeze({
  phase: 'pre-alpha',
  browser: 'chrome',
  toolsRegistered: false,
})

export function apply() {
  // Browser services and tools arrive with the first tested vertical slice.
}
