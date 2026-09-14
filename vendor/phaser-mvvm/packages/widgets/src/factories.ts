/**
 * Widget factories: the plain functions and the `this.add.*` registrations.
 *
 * The factories share one signature, `(scene, options?, children?)`, mirroring the declarative
 * container helpers in `@phaser-mvvm/phaser` (`vbox`/`hbox`/…): the widget is constructed, registered
 * with the scene and returned. `children` is only *arranged* by `Panel` (the one container here);
 * leaves accept it so the family stays uniform, and those children simply sit at the widget's origin.
 * `uiRepeat` is the exception: it builds its rows from `template`, so it takes no children.
 *
 * The `ui*` names are registered on `Phaser.GameObjects.GameObjectFactory` rather than via
 * `scene.add.existing`, so widget creation can be called as `this.add.uiButton({...})` from a Scene.
 * `uiLabel` deliberately replaces the probe implementation registered by `@phaser-mvvm/phaser`, and
 * `uiImage` cannot be called `image` because Phaser already owns that key.
 */

import Phaser from 'phaser';
import type { Widget } from '@phaser-mvvm/phaser';
import { Button, type ButtonOptions } from './Button';
import { Divider, type DividerOptions } from './Divider';
import { Image, type ImageOptions } from './Image';
import { Label, type LabelOptions } from './Label';
import { Panel, type PanelOptions } from './Panel';
import { Repeat, type RepeatOptions } from './Repeat';
import { ScrollView, type ScrollViewOptions } from './ScrollView';
import { Slider, type SliderOptions } from './Slider';
import { Spacer, type SpacerOptions } from './Spacer';
import { TextArea, type TextAreaOptions } from './TextArea';
import { TextField, type TextFieldOptions } from './TextField';

/** Attaches children, adds the widget to the scene and returns it. */
function finish<T extends Widget>(
  scene: Phaser.Scene,
  widget: T,
  children: readonly Widget[] = [],
): T {
  for (const child of children) {
    widget.addWidget(child);
  }
  scene.add.existing(widget);
  return widget;
}

/** Creates a text label and adds it to the Scene. */
export function label(
  scene: Phaser.Scene,
  options: LabelOptions = {},
  children: readonly Widget[] = [],
): Label {
  return finish(scene, new Label(scene, options), children);
}

/** Creates a panel (a themed box container) and adds it to the Scene. */
export function panel(
  scene: Phaser.Scene,
  options: PanelOptions = {},
  children: readonly Widget[] = [],
): Panel {
  return finish(scene, new Panel(scene, options), children);
}

/** Creates a button and adds it to the Scene. */
export function button(
  scene: Phaser.Scene,
  options: ButtonOptions = {},
  children: readonly Widget[] = [],
): Button {
  return finish(scene, new Button(scene, options), children);
}

/** Creates a texture image and adds it to the Scene (`uiImage` as a factory, since `image` is taken). */
export function uiImage(
  scene: Phaser.Scene,
  options: ImageOptions,
  children: readonly Widget[] = [],
): Image {
  return finish(scene, new Image(scene, options), children);
}

/** Creates a layout spacer and adds it to the Scene. */
export function spacer(
  scene: Phaser.Scene,
  options: SpacerOptions = {},
  children: readonly Widget[] = [],
): Spacer {
  return finish(scene, new Spacer(scene, options), children);
}

/** Creates a horizontal or vertical divider and adds it to the Scene. */
export function divider(
  scene: Phaser.Scene,
  options: DividerOptions = {},
  children: readonly Widget[] = [],
): Divider {
  return finish(scene, new Divider(scene, options), children);
}

/** Creates a single-line text input and adds it to the Scene. */
export function textField(
  scene: Phaser.Scene,
  options: TextFieldOptions = {},
  children: readonly Widget[] = [],
): TextField {
  return finish(scene, new TextField(scene, options), children);
}

/** Creates a multi-line text input and adds it to the Scene. */
export function textArea(
  scene: Phaser.Scene,
  options: TextAreaOptions = {},
  children: readonly Widget[] = [],
): TextArea {
  return finish(scene, new TextArea(scene, options), children);
}

/** Creates a clipped scroll viewport and adds it to the Scene. */
export function uiScroll(
  scene: Phaser.Scene,
  options: ScrollViewOptions = {},
  children: readonly Widget[] = [],
): ScrollView {
  const widget = new ScrollView(scene, options);
  if (options.content === undefined && children.length > 0) {
    widget.setContent(children[0] as Widget);
  }
  scene.add.existing(widget);
  return widget;
}

/** Creates a slider widget and adds it to the Scene. */
export function uiSlider(scene: Phaser.Scene, options: SliderOptions = {}): Slider {
  const widget = new Slider(scene, options);
  scene.add.existing(widget);
  return widget;
}

/**
 * Creates a keyed, optionally virtualised list and adds it to the Scene.
 *
 * No `children` parameter: a `Repeat` builds its rows from `template`, so there is nothing to attach
 * by hand.
 */
export function uiRepeat<Item>(scene: Phaser.Scene, options: RepeatOptions<Item>): Repeat<Item> {
  const widget = new Repeat<Item>(scene, options);
  scene.add.existing(widget);
  return widget;
}

// --------------------------------------------------------------------- this.add.*

interface FactoryInternals {
  scene: Phaser.Scene;
}

type RegisterFn = (this: unknown, ...args: unknown[]) => unknown;
type FactoryRegistry = {
  register(key: string, fn: RegisterFn): void;
  remove(key: string): void;
};

/** Factory keys registered by this package. */
export const WIDGET_FACTORY_KEYS = [
  'uiLabel',
  'uiPanel',
  'uiButton',
  'uiImage',
  'uiSpacer',
  'uiDivider',
  'uiSlider',
  'uiTextField',
  'uiTextArea',
  'uiRepeat',
  'uiScroll',
] as const;

let installed = false;

/**
 * Registers the widget factories on `scene.add`. Idempotent, and safe to call from a module top level.
 *
 * `Phaser.GameObjects.GameObjectFactory.register()` deliberately ignores a key that is already taken,
 * so the keys are released with `remove()` first: the widget library owns the `ui*` names, and
 * `uiLabel` in particular replaces the probe widget the adapter shipped before this package existed.
 * The call order with `installFactories()` therefore does not matter, and the last one to run wins.
 */
export function installWidgetFactories(): void {
  if (installed) {
    return;
  }
  installed = true;

  const registry = Phaser.GameObjects.GameObjectFactory as unknown as FactoryRegistry;
  const sceneOf = (self: unknown): Phaser.Scene => (self as FactoryInternals).scene;

  for (const key of WIDGET_FACTORY_KEYS) {
    registry.remove(key);
  }

  registry.register('uiLabel', function (this: unknown, options, children) {
    return label(
      sceneOf(this),
      (options as LabelOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiPanel', function (this: unknown, options, children) {
    return panel(
      sceneOf(this),
      (options as PanelOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiButton', function (this: unknown, options, children) {
    return button(
      sceneOf(this),
      (options as ButtonOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiImage', function (this: unknown, options, children) {
    return uiImage(
      sceneOf(this),
      options as ImageOptions,
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiSpacer', function (this: unknown, options, children) {
    return spacer(
      sceneOf(this),
      (options as SpacerOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiDivider', function (this: unknown, options, children) {
    return divider(
      sceneOf(this),
      (options as DividerOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiSlider', function (this: unknown, options) {
    return uiSlider(sceneOf(this), (options as SliderOptions) ?? {});
  });

  registry.register('uiTextField', function (this: unknown, options, children) {
    return textField(
      sceneOf(this),
      (options as TextFieldOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiTextArea', function (this: unknown, options, children) {
    return textArea(
      sceneOf(this),
      (options as TextAreaOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });

  registry.register('uiRepeat', function (this: unknown, options) {
    return uiRepeat(sceneOf(this), options as RepeatOptions<unknown>);
  });

  registry.register('uiScroll', function (this: unknown, options, children) {
    return uiScroll(
      sceneOf(this),
      (options as ScrollViewOptions) ?? {},
      (children as Widget[] | undefined) ?? [],
    );
  });
}

/** True once `installWidgetFactories()` has run in this process. */
export function widgetFactoriesInstalled(): boolean {
  return installed;
}
