/**
 * The "is the scene plugin even here?" guard.
 *
 * `Phaser.Scene.mvvm` is declared globally as **non-optional** (`augment.ts`), which is what makes
 * `this.mvvm.root` ergonomic in every scene. The price is that TypeScript cannot warn about the case
 * that actually happens to a new project: a game whose `plugins.scene` entry is missing or misspelled,
 * where `this.mvvm` is `undefined` at runtime and the first access fails with
 * `Cannot read properties of undefined (reading 'root')` — a message that says nothing about the fix.
 *
 * The check lives in its own module, with **no runtime import of Phaser**, so it can be unit-tested in
 * plain Node like the rest of `packages/phaser`'s pure logic (importing Phaser in Node fails: the ESM
 * bundle touches the DOM at module scope).
 */

import type Phaser from 'phaser';
import type { MVVMPlugin } from './plugin';

/**
 * Returns the scene's `MVVMPlugin`, or throws an error that contains the Game Config entry to add.
 *
 * `UIScene` calls it in `create()`, so a `UIScene` without the plugin fails at startup with the fix in
 * the message instead of somewhere deep inside a layout pass.
 */
export function requireMVVMPlugin(scene: Phaser.Scene): MVVMPlugin {
  const plugin = (scene as { mvvm?: MVVMPlugin }).mvvm;
  if (plugin) {
    return plugin;
  }
  const key = (scene as { sys?: { settings?: { key?: string } } }).sys?.settings?.key;
  throw new Error(
    `phaser-mvvm: the scene ${key ? `"${key}" ` : ''}has no MVVMPlugin, so there is no \`this.mvvm\` ` +
      'to build a UI with. Register it in the Game Config:\n' +
      "  plugins: { scene: [{ key: 'MVVMPlugin', plugin: MVVMPlugin, mapping: 'mvvm' }] }",
  );
}
