/**
 * Reactive arguments of the Compose-style DSL.
 *
 * A DSL slot that describes *data* — `Text`'s string, a field's value, a label's text — accepts three
 * shapes:
 *
 * | shape                     | meaning                                                   |
 * | ------------------------- | --------------------------------------------------------- |
 * | `'保存'`                  | constant; no binding is created                            |
 * | `ref('保存')`             | tracked, and *two-way* where the widget can write back     |
 * | `() => vm.title.value`    | tracked, one-way (re-evaluated on the frame the value flips) |
 *
 * Detection is `isRef()` plus `typeof === 'function'`, which is why only data slots may use these
 * types: a function-valued option (`onClick`) would be mistaken for a getter. Keep such options plain.
 *
 * Everything here is pure, so the rules are unit-tested in plain Node.
 */

import { isRef, warn, type Ref } from '@phaser-mvvm/core';

/** A constant, a `Ref`, or a getter — the three shapes a data option accepts. */
export type ReactiveSource<T> = T | Ref<T> | (() => T);

/** True when the value must be tracked; constants skip the binding altogether. */
export function isReactiveSource<T>(value: ReactiveSource<T>): boolean {
  return isRef(value) || typeof value === 'function';
}

/** Reads the current value without creating a dependency. */
export function readReactive<T>(value: ReactiveSource<T>): T {
  if (isRef(value)) {
    return value.value;
  }
  if (typeof value === 'function') {
    return (value as () => T)();
  }
  return value;
}

/** Wraps the source into a getter for `bindText`/`bindModel`. */
export function sourceGetter<T>(value: ReactiveSource<T>): () => T {
  return () => readReactive(value);
}

/** True when the DSL can write back to the source (only a `Ref` can). */
export function isWritableSource<T>(value: ReactiveSource<T>): boolean {
  return isRef(value);
}

/**
 * Writes through to a `Ref` source.
 *
 * A getter cannot be written, so this is a no-op with a development warning: silently dropping the
 * write would look like "the field refuses my typing" rather than "pass a ref or an onValueChange".
 */
export function writeReactive<T>(value: ReactiveSource<T>, next: T): void {
  if (isRef(value)) {
    value.value = next;
    return;
  }
  warn(
    'writeReactive(): a getter is read-only, so the edit cannot be stored. Pass a ref() for two-way ' +
      'binding, or use onValueChange to hoist the state yourself.',
  );
}
