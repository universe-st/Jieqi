/**
 * `makeObservable` turns the own data properties of a class instance into tracked accessors, so a
 * plain class can act as a ViewModel without extending any base class:
 *
 * ```ts
 * class Counter {
 *   count = 0;
 *   items = [] as number[];
 *   constructor() {
 *     makeObservable(this);
 *     // or: makeObservable(this, { items: 'reactive' });
 *   }
 * }
 * ```
 *
 * It is compatible with `useDefineForClassFields: true`: fields that TypeScript already defined as
 * own data properties (including uninitialised ones) are redefined as accessors backed by a
 * reactive unit, while methods and already-defined accessors are left alone.
 */

import type { Ref } from './ref';
import { ref, shallowRef } from './ref';
import { isArray, isPlainObject } from '../utils/shared';

/** How a field is stored internally. */
export type ObservableKind =
  /** Tracked as a unit: assignment notifies, nested mutation of an object does not. */
  | 'ref'
  /** Assignment notifies and plain objects/arrays are wrapped with `reactive()`. */
  | 'reactive'
  /** Like `'ref'`, but never deep-converts a later assignment either. */
  | 'shallow';

/** Per-field declaration accepted by `makeObservable`. */
export type ObservableSpec<T> = { [K in keyof T]?: ObservableKind };

function defaultKind(value: unknown): ObservableKind {
  return isPlainObject(value) || isArray(value) ? 'reactive' : 'ref';
}

function createUnit(kind: ObservableKind, value: unknown): Ref<unknown> {
  if (kind === 'reactive') {
    // `ref()` already deep-converts plain objects and arrays and leaves everything else alone.
    return ref(value);
  }
  return shallowRef(value);
}

/**
 * Converts every own enumerable data property of `instance` into a tracked accessor.
 *
 * Fields declared in `spec` use the declared kind; undeclared fields keep the default
 * (objects and arrays become `'reactive'`, everything else becomes `'ref'`). Function-valued
 * fields (arrow handlers) and existing accessors are untouched.
 */
export function makeObservable<T extends object>(instance: T, spec?: ObservableSpec<T>): T {
  const target = instance as Record<string, unknown>;
  const declared = (spec ?? {}) as Record<string, ObservableKind | undefined>;

  const keys = new Set<string>(Object.keys(target));
  for (const key of Object.keys(declared)) keys.add(key);

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor !== undefined && !('value' in descriptor)) continue;
    const value: unknown = descriptor?.value;
    if (typeof value === 'function') continue;

    const kind = declared[key] ?? defaultKind(value);
    const unit = createUnit(kind, value);

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => unit.value,
      set: (next: unknown) => {
        unit.value = next;
      },
    });
  }

  return instance;
}

/** Wraps a value the same way `makeObservable` would for the given kind (advanced use). */
export function observableUnit<T>(value: T, kind: ObservableKind = defaultKind(value)): Ref<T> {
  return createUnit(kind, value) as Ref<T>;
}
