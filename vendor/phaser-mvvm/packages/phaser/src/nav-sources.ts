/**
 * The two navigation sources the framework ships: the keyboard and pad 0.
 *
 * They live apart from `nav.ts` on purpose. `nav.ts` is Phaser-free (type imports only) so its logic
 * runs in Node; these two classes exist to hold the Phaser objects (`scene.input.keyboard`,
 * `scene.input.gamepad`) and are therefore only meaningful inside a running game. Their *decisions*
 * still come from `nav.ts` (`keyboardActionOf`, `gamepadActionsOf`, `heldDirectionsOf`) — a source is
 * wiring, not policy.
 *
 * What deliberately stayed in the host (`MVVMPlugin`) is everything that is about the *scene* rather
 * than the device: the key-event de-duplication Phaser's input queue requires, the browser-shortcut
 * guard, `preventDefault()`, the focused widget's first refusal, and the hold-to-repeat clock. A third
 * source added by an app gets all of that for free by calling `host.dispatch()`.
 */

import type Phaser from 'phaser';
import {
  heldDirectionsOf,
  gamepadActionsOf,
  keyboardActionOf,
  type NavDirection,
  type NavInputState,
  type NavSource,
  type NavSourceHost,
} from './nav';

/** Empty snapshot used until a pad is seen for the first time. */
const EMPTY_NAV_STATE: NavInputState = { axes: [], buttons: [] };

/**
 * `keydown` → navigation actions.
 *
 * A pure event source: no `heldDirections()` and no `poll()`, because a key press is a discrete event
 * that Phaser already delivers. The mapping is `keyboardActionOf()`, and the raw event goes to the host
 * so that a focused text field can consume it first.
 */
export class KeyboardNavSource implements NavSource {
  readonly name = 'keyboard';
  readonly source = 'keyboard' as const;

  attach(host: NavSourceHost): () => void {
    const keyboard = host.scene?.input?.keyboard;
    if (!keyboard) {
      return () => undefined;
    }
    const listener = (event: KeyboardEvent): void => {
      host.handleKeyEvent(event, keyboardActionOf(event));
    };
    keyboard.on('keydown', listener);
    return () => keyboard.off('keydown', listener);
  }
}

/**
 * Pad 0 → navigation actions.
 *
 * Both halves of the interface are used, because a gamepad is *read* rather than subscribed to:
 *
 * - `poll()` reports the **edge**-triggered actions (`activate`, `back`) — holding a D-Pad direction
 *   must produce one action, so directions are not dispatched here;
 * - `heldDirections()` reports the directions currently held, and the host's `NavRepeat` turns that
 *   into one action plus auto-repeat at the framework's own timing (350 ms → 90 ms).
 *
 * The "previous" snapshot is per-source state (`gamepadActionsOf` keeps no memory), which is why the
 * class — rather than the plugin — owns it: two pads polled in the same frame can no longer share one
 * snapshot and swallow each other's edges.
 */
export class GamepadNavSource implements NavSource {
  readonly name: string;
  readonly source = 'gamepad' as const;

  /** Which pad this source reads; `0` is the first connected pad. */
  private readonly index: number;
  private state: NavInputState = EMPTY_NAV_STATE;
  private held: readonly NavDirection[] = [];

  constructor(index = 0, name = index === 0 ? 'gamepad' : `gamepad-${index}`) {
    this.index = index;
    this.name = name;
  }

  poll(host: NavSourceHost): void {
    const pad = padOf(host, this.index);
    if (!pad) {
      // The pad went away (unplugged, or the game was created without gamepad support): forget the
      // snapshot, so plugging it back in starts from "nothing was held" instead of replaying edges.
      this.state = EMPTY_NAV_STATE;
      this.held = [];
      return;
    }
    const snapshot = gamepadActionsOf(pad, this.state);
    this.state = snapshot.state;
    this.held = heldDirectionsOf(snapshot.state);
    for (const action of snapshot.actions) {
      if (action === 'activate' || action === 'back') {
        host.dispatch(action, this.source);
      }
    }
  }

  heldDirections(): readonly NavDirection[] {
    return this.held;
  }
}

/** Reads one pad off the scene, tolerating a game created without gamepad support. */
function padOf(host: NavSourceHost, index: number): Phaser.Input.Gamepad.Gamepad | null {
  const pads = (host.scene?.input as { gamepad?: { getPad(index: number): unknown } } | undefined)
    ?.gamepad;
  return (pads?.getPad(index) ?? null) as Phaser.Input.Gamepad.Gamepad | null;
}
