/**
 * The plugin's option surface and the merge rule behind `MVVMPlugin.configure()`.
 *
 * This module is deliberately **Phaser-free** (`import type` only): merging two option bags is pure
 * logic, and it is the one function every new sub-option bag has to be added to — a bag that is
 * missing here is not a type error, it is a silent "one patch wipes its siblings" bug. Keeping it out
 * of `plugin.ts` is what lets `test/plugin-config.test.ts` cover it in Node, without a renderer.
 */

import type { A11yOptions } from './a11y';
import type { FocusManagerOptions } from './focus';
import type { InputRouterOptions } from './input';
import type { TransitionOptions } from './transition';
import type { UIRootOptions } from './UIRoot';

export interface MVVMPluginConfig extends UIRootOptions {
  /**
   * Resolution the widgets bake their **text textures** at, in device pixels per layout unit.
   *
   * Widgets create one canvas texture per label/button/field line (`Phaser.GameObjects.Text`), and that
   * texture is rasterised at the font size in *layout units*. On a display denser than the drawing
   * buffer the browser then upsamples it and every glyph goes soft — the one thing a camera transform
   * or a bigger buffer cannot fix after the fact.
   *
   * Omitted (the default), each scene measures the ratio itself
   * (`devicePixelRatio × canvas CSS width ÷ game size`), rounds it to a ½ step and caps it at 2: `1.5`
   * for a 450×900 `FIT` design shown at 0.75 scale on a Retina display, `2` for a `RESIZE` game on any
   * HiDPI screen. Text created **before** the option changed keeps its texture. `1` turns the extra
   * resolution off — texture memory grows with the square of this number, so it is the knob for a tight
   * mobile budget, and `3` on a high-DPI phone is the opposite trade.
   */
  textResolution?: number;
  /** Focus behaviour overrides (the root is supplied by the plugin). */
  focus?: Omit<FocusManagerOptions, 'root'>;
  /** Pointer routing overrides (the root is supplied by the plugin). */
  input?: Omit<InputRouterOptions, 'root'>;
  /** Keyboard/gamepad navigation. Defaults to `true`. */
  navigation?: boolean;
  /**
   * Hidden DOM mirror for screen readers. Defaults to `true`; `false` (or
   * `this.mvvm.a11y.enabled = false`) keeps the layer out of the DOM entirely.
   */
  a11y?: A11yOptions | false;
  /** Callback for the `back` action (Escape / gamepad B) when no widget handles it. */
  onBack?: () => void;
  /**
   * Paint the scene's main camera with `theme.colors.background` (and keep it in sync on theme
   * changes). Defaults to `true`; set to `false` for a UI scene that must stay transparent over a
   * running game scene.
   */
  themeBackground?: boolean;
  /**
   * Open/close motion for overlay layers (PLAN M8's 开闭动效). Defaults to a 160 ms fade-in and a
   * 120 ms fade-out; `false` makes every layer appear and disappear on the spot.
   *
   * ```ts
   * MVVMPlugin.configure({ transition: { exit: 0 } });          // fade in, vanish on close
   * MVVMPlugin.configure({ transition: false });                // no motion at all
   * ```
   */
  transition?: TransitionOptions | false;
}

/**
 * Merges two plugin configs one level deep.
 *
 * `input`, `focus`, `a11y`, `layout` and `transition` are option bags of their own, so a later
 * `configure()` that only mentions `focus.wrap` must not wipe `input.dragThreshold` — a shallow spread
 * would. `false` in a patch means "turn this feature off" and wins over the base bag; a bag patch merges
 * into it (so `configure({ a11y: { politeness: 'assertive' } })` after `a11y: false` switches the mirror
 * back on with that one option set).
 */
export function mergePluginConfig(
  base: MVVMPluginConfig,
  patch: MVVMPluginConfig,
): MVVMPluginConfig {
  const merged: MVVMPluginConfig = { ...base, ...patch };
  if (base.input || patch.input) {
    merged.input = { ...base.input, ...patch.input };
  }
  if (base.focus || patch.focus) {
    merged.focus = { ...base.focus, ...patch.focus };
  }
  if (base.a11y !== undefined || patch.a11y !== undefined) {
    merged.a11y =
      patch.a11y === false
        ? false
        : patch.a11y === undefined
          ? base.a11y
          : { ...(base.a11y === false ? {} : (base.a11y ?? {})), ...patch.a11y };
  }
  if (base.layout || patch.layout) {
    merged.layout = { ...base.layout, ...patch.layout };
  }
  // `transition` is a sub-option bag like the ones above: a patch that only sets `transition.exit`
  // must not wipe the configured `enter`.
  if (base.transition !== undefined || patch.transition !== undefined) {
    merged.transition =
      patch.transition === false
        ? false
        : patch.transition === undefined
          ? base.transition
          : {
              ...(base.transition === false || base.transition === undefined
                ? {}
                : base.transition),
              ...patch.transition,
            };
  }
  return merged;
}

/**
 * Pulls the plugin's options out of the Game Config's scene-plugin entries.
 *
 * Phaser instantiates a scene plugin as `new Plugin(scene, pluginManager, mapKey)`: of a Game Config
 * entry it only ever reads `key`, `plugin` and `mapping`, and the fourth (config) argument a plugin
 * would like is never passed. Guide 08 §5.3 documented that as a permanent limitation for years and
 * pushed everyone to `MVVMPlugin.configure()` — which is *global*, and therefore useless for an app
 * that boots two games or for a library that wants to configure itself without touching a static.
 *
 * The options ride in the entry's **`data`** field and the plugin reads them back from
 * `game.config.installScenePlugins` — the array Phaser keeps **verbatim** (`Config.js` copies
 * `plugins.scene` straight into it). `data` is the one typed slot in `PluginObjectItem` that is free
 * here: it is documented as "arbitrary data passed to the plugin's `init()` method", and Phaser only
 * does that for *global* plugins, so a scene plugin owns it.
 *
 * ```ts
 * plugins: {
 *   scene: [{
 *     key: 'MVVMPlugin',
 *     plugin: MVVMPlugin,
 *     mapping: 'mvvm',
 *     data: { a11y: { politeness: 'assertive' }, transition: { enter: 0 } },
 *   }],
 * }
 * ```
 *
 * `pluginKey` is whatever Phaser handed the constructor in the third argument — and on the Game Config
 * path that is the **`mapping`**, not the `key` (`PluginManager#addToScene` passes
 * `PluginCache.getCore(key).mapping`, so a plugin registered as `mapping: 'mvvm'` sees `"mvvm"`).
 * Both fields are therefore matched: an entry identifies a plugin by either name, and only one of them
 * is available depending on how the plugin was installed.
 *
 * Several entries registered under the same key are merged in order. Anything that is not a plain
 * object in `data` is ignored, so a payload meant for something else cannot break the constructor.
 */
export function pluginConfigFromGameConfig(entries: unknown, pluginKey: string): MVVMPluginConfig {
  if (!Array.isArray(entries) || !pluginKey) {
    return {};
  }
  let merged: MVVMPluginConfig = {};
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as { key?: unknown; mapping?: unknown; data?: unknown };
    if (record.key !== pluginKey && record.mapping !== pluginKey) {
      continue;
    }
    const data = record.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      continue;
    }
    merged = mergePluginConfig(merged, data as MVVMPluginConfig);
  }
  return merged;
}
