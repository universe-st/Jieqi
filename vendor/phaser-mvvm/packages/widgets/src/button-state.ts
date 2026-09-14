/**
 * The `Button` state machine, as pure functions.
 *
 * The widget itself is a `Phaser.GameObjects.Container` and cannot be instantiated in Node, so every
 * decision it makes — is this activation honoured, does the value flip, does `onClick` run, what is
 * painted while loading — is expressed here and unit-tested without a renderer.
 */

import type { WidgetState } from '@phaser-mvvm/phaser';
import { ELLIPSIS } from './text-truncate';

export interface ButtonActivationInput {
  /** `Widget.enabled`; a disabled button never activates. */
  enabled?: boolean;
  /** A button that is loading ignores activations (its async action is already running). */
  loading?: boolean;
  /** Toggle mode: the activation flips `value` instead of running `onClick`. */
  toggle?: boolean;
  /** Current toggle value. */
  value?: boolean;
}

export interface ButtonActivationDecision {
  /** The activation is dropped: nothing changes and no event is emitted. */
  ignored: boolean;
  /** `value` flips as a result of this activation. */
  toggles: boolean;
  /** Value after the activation (unchanged when the activation is ignored). */
  value: boolean;
  /** `onClick` must be invoked. */
  invokesClick: boolean;
  /** A `change` event must be emitted with `value`. */
  emitsChange: boolean;
}

/**
 * Decides what an activation does.
 *
 * Order matters: `enabled === false` and `loading` both win over everything else, then `toggle`
 * takes the activation (flipping the value and emitting `change`) and only a plain button runs
 * `onClick`. A toggle button therefore reports its state through `change`; use that instead of
 * `onClick` for toggle semantics.
 */
export function resolveButtonActivation(
  input: ButtonActivationInput = {},
): ButtonActivationDecision {
  const value = input.value === true;

  if (input.enabled === false || input.loading === true) {
    return {
      ignored: true,
      toggles: false,
      value,
      invokesClick: false,
      emitsChange: false,
    };
  }

  if (input.toggle === true) {
    return {
      ignored: false,
      toggles: true,
      value: !value,
      invokesClick: false,
      emitsChange: true,
    };
  }

  return {
    ignored: false,
    toggles: false,
    value,
    invokesClick: true,
    emitsChange: false,
  };
}

export interface ButtonVisualStateInput {
  /** State derived by `Widget` from the interaction flags. */
  state: WidgetState;
  loading?: boolean;
  toggle?: boolean;
  value?: boolean;
}

/**
 * The state the skin is painted with.
 *
 * - `loading` paints as `disabled` (PLAN §4.5: a loading button is visibly unavailable while it still
 *   ignores activation),
 * - a toggle that is on paints as `pressed` while it is idle **or focused**, so its state survives a
 *   focus change (the focus ring is drawn separately by the widget, not by the skin),
 * - the pointer states are passed through, so hovering or pressing still gives feedback,
 * - everything else paints as itself.
 */
export function resolveButtonState(input: ButtonVisualStateInput): WidgetState {
  if (input.loading === true) {
    return 'disabled';
  }
  if (input.toggle === true && input.value === true) {
    return input.state === 'normal' || input.state === 'focused' ? 'pressed' : input.state;
  }
  return input.state;
}

/** The visible label: a loading button keeps its text and gains a trailing ellipsis. */
export function buttonLabel(text: string, loading: boolean, ellipsis: string = ELLIPSIS): string {
  return loading ? `${text}${ellipsis}` : text;
}
