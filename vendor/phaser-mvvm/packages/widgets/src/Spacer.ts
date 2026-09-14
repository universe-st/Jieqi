/**
 * `Spacer` — pure layout filler.
 *
 * A spacer has no container and no content: its size comes entirely from its `LayoutParams`, and its
 * job is to push siblings apart (`flex: true` is shorthand for `grow: 1` on the parent's main axis) or
 * to reserve a fixed gap. It draws nothing and is never hit-testable.
 */

import type { BoxConstraints, LayoutParams, Size } from '@phaser-mvvm/layout';
import { Widget, type PointerChainOptionHooks } from '@phaser-mvvm/phaser';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';

export interface SpacerOptions extends LayoutParams, PointerChainOptionHooks {
  /**
   * Shorthand for `grow: 1`. An explicit `grow` wins, so `{ flex: true, grow: 2 }` uses the weight 2.
   */
  flex?: boolean;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type SpacerWidgetOptions = Omit<SpacerOptions, keyof LayoutParams | 'name'>;

const SPACER_KEYS = ['flex'] as const;

export class Spacer extends Widget {
  constructor(scene: Phaser.Scene, options: SpacerOptions = {}) {
    const { layout, widget } = splitWidgetOptions<SpacerWidgetOptions>(
      optionBag(options),
      SPACER_KEYS,
    );
    if (widget.flex === true && layout.grow === undefined) {
      layout.grow = 1;
    }
    super(scene, { layout, ...baseWidgetOptions(options) });

    // A leaf: nothing to arrange, nothing to measure beyond the params themselves.
    this.container = null;
  }

  override measureContent(_constraint: BoxConstraints): Size {
    return { width: 0, height: 0 };
  }
}
