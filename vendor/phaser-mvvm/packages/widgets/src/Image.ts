/**
 * `Image` — a texture drawn inside a layout rect.
 *
 * The widget owns a `Phaser.GameObjects.Image` and never lets the layout engine scale it: the frame's
 * natural size is remembered, `fit` maps the assigned rect onto a scale plus a centring offset
 * (`fit.ts`), and the result is written back with `setScale`/`setPosition`. `contain` is the default,
 * because a UI image that silently stretches is the more common bug.
 *
 * Its intrinsic size is the texture's, so `image({ texture: 'logo' })` measured inside a panel needs
 * no explicit `width`/`height`.
 */

import Phaser from 'phaser';
import type { BoxConstraints, LayoutParams, Rect, Size } from '@phaser-mvvm/layout';
import { Widget, type PointerChainOptionHooks } from '@phaser-mvvm/phaser';
import { computeFit, type ImageFit } from './fit';
import { contentBox } from './geometry';
import { optionBag, splitWidgetOptions, baseWidgetOptions } from './options';

export type { ImageFit } from './fit';

export interface ImageOptions extends LayoutParams, PointerChainOptionHooks {
  /** Texture key, as registered with `scene.textures`. */
  texture: string;
  /** Optional frame name inside the texture. */
  frame?: string;
  /** How the texture is mapped onto the assigned rect. Defaults to `'contain'`. */
  fit?: ImageFit;
  name?: string;
  /** Tab order hint for the focus manager (lower first). */
  focusOrder?: number;
  /** Accessible name for the DOM mirror (see `Widget.a11yLabel`); defaults to the visible text. */
  label?: string;
}

type ImageWidgetOptions = Omit<ImageOptions, keyof LayoutParams | 'name'>;

const IMAGE_KEYS = ['texture', 'frame', 'fit'] as const;

export class Image extends Widget {
  /** The underlying Phaser image; exposed for tinting and custom effects. */
  readonly image: Phaser.GameObjects.Image;

  private fit: ImageFit;
  private naturalWidth = 0;
  private naturalHeight = 0;
  /** Texture key on screen; tracked here because Phaser's own `texture.key` is not the widget's slot. */
  private textureKey: string;
  private frameName: string | undefined;

  constructor(scene: Phaser.Scene, options: ImageOptions) {
    const { layout, widget } = splitWidgetOptions<ImageWidgetOptions>(
      optionBag(options),
      IMAGE_KEYS,
    );
    super(scene, { layout, ...baseWidgetOptions(options) });

    this.fit = widget.fit ?? 'contain';
    this.textureKey = widget.texture;
    this.frameName = widget.frame;
    this.image = new Phaser.GameObjects.Image(scene, 0, 0, widget.texture, widget.frame);
    this.image.setOrigin(0, 0);
    this.add(this.image);
    this.captureNaturalSize();
  }

  /**
   * Texture key currently on screen.
   *
   * The compose `Image()` texture and frame slots are two data slots over *one* Phaser call
   * (`setTexture(key, frame)`), so each has to be able to read the other half instead of overwriting it.
   */
  get currentTexture(): string {
    return this.textureKey;
  }

  /** Frame name currently on screen, or `undefined` when the texture's first frame is used. */
  get currentFrame(): string | undefined {
    return this.frameName;
  }

  /** How the texture is mapped onto the rect. */
  get imageFit(): ImageFit {
    return this.fit;
  }

  setFit(fit: ImageFit): this {
    if (this.fit === fit) {
      return this;
    }
    this.fit = fit;
    this.onRectChanged(this.rect);
    return this;
  }

  /**
   * Swaps the texture (and optionally the frame), then re-measures.
   *
   * The frame that gets recorded is the one **Phaser resolved**, not the one that was asked for:
   * `Texture#get` warns and falls back to the texture's first frame when the name is unknown, so
   * echoing the request would make `currentFrame` claim a frame that is not on screen (measured:
   * `setTexture('compose.atlas', 'nope')` kept painting `red` while `currentFrame` said `'nope'`).
   * The warning still names the miss, which is the part a caller needs to act on.
   */
  setTexture(texture: string, frame?: string): this {
    if (texture === this.textureKey && frame === this.frameName) {
      return this;
    }
    this.image.setTexture(texture, frame);
    this.textureKey = texture;
    // No requested frame keeps `undefined` (the caller never named one); a requested frame is recorded
    // as resolved, so a missing name reads as the frame that is actually painted.
    this.frameName =
      frame === undefined
        ? undefined
        : ((this.image.frame as { name?: string } | null)?.name ?? frame);
    this.captureNaturalSize();
    this.markDirty();
    return this;
  }

  /** Natural (unscaled) size of the current frame. */
  get naturalSize(): Size {
    return { width: this.naturalWidth, height: this.naturalHeight };
  }

  override measureContent(_constraint: BoxConstraints): Size {
    return { width: this.naturalWidth, height: this.naturalHeight };
  }

  protected override onRectChanged(rect: Rect): void {
    const box = contentBox(rect.width, rect.height, this.layoutParams.padding);
    if (box.width <= 0 || box.height <= 0) {
      // A rect without area is not a valid box to fit into; hide instead of drawing an overflow.
      this.image.setVisible(false);
      return;
    }

    this.image.setVisible(true);
    const fit = computeFit(this.naturalWidth, this.naturalHeight, box.width, box.height, this.fit);
    this.image.setScale(fit.scaleX, fit.scaleY);
    this.image.setPosition(box.x + fit.offsetX, box.y + fit.offsetY);
  }

  private captureNaturalSize(): void {
    this.naturalWidth = this.image.width;
    this.naturalHeight = this.image.height;
  }
}
