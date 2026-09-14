/**
 * Widget interaction state, shared by the adapter, the input router and the widget library.
 *
 * The state machine is deliberately tiny (`normal`/`hover`/`pressed`/`disabled`/`focused`/`error`)
 * because every widget paints from it: `Skin#paint()` receives exactly this value.
 */

export type WidgetState = 'normal' | 'hover' | 'pressed' | 'disabled' | 'focused' | 'error';

export interface WidgetStateFlags {
  enabled?: boolean;
  hovered?: boolean;
  pressed?: boolean;
  focused?: boolean;
  error?: boolean;
}

/**
 * Resolves the visual state from the interaction flags.
 *
 * Priority: `disabled` wins, then `error`, then the pointer states, then keyboard focus. `error`
 * outranks focus so a focused invalid field still looks invalid.
 */
export function resolveWidgetState(flags: WidgetStateFlags): WidgetState {
  if (flags.enabled === false) {
    return 'disabled';
  }
  if (flags.error) {
    return 'error';
  }
  if (flags.pressed) {
    return 'pressed';
  }
  if (flags.hovered) {
    return 'hover';
  }
  if (flags.focused) {
    return 'focused';
  }
  return 'normal';
}

/**
 * What `widget:state` should announce after a repaint: the new state, or `null` when it did not change.
 *
 * `appearanceChanged()` runs on **every** repaint — a theme switch, a variant change, a validation
 * error — while `WIDGET_EVENTS.STATE_CHANGE` promises a *change*. Announcing unconditionally sent the
 * same state twice inside one click (measured on `#/states`: `pressed, pressed, focused, hover`), which
 * makes a subscriber that counts transitions wrong and one that asks "did it enter `pressed`?" fire
 * twice. `previous === null` (nothing announced yet) always announces.
 */
export function announceableState(
  previous: WidgetState | null,
  current: WidgetState,
): WidgetState | null {
  return previous === current ? null : current;
}
