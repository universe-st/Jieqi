/**
 * Watchers built on top of `effect`.
 *
 * `watch(source, callback)` accepts a ref/computed, a getter, a reactive object (which implies
 * `deep`) or an array of sources. `watchEffect(fn)` runs immediately and re-runs whenever one of
 * the dependencies it read changes. Both return a callable handle carrying `stop`/`pause`/`resume`.
 *
 * Change detection: values are compared with `Object.is` semantics (so `NaN` is stable). With
 * `deep: true` the same reference means "a nested mutation woke the watcher" and fires, while two
 * different references are compared structurally so an equal rebuild does not fire.
 */

import type { Ref } from './ref';
import { isRef } from './ref';
import type { ComputedRef } from './computed';
import type { EffectCleanup, EffectHandle, OnCleanup } from './effect';
import { ReactiveEffect, toEffectHandle } from './effect';
import type { EffectScope } from './scope';
import type { FlushMode } from './scheduler';
import { isReactive } from './reactive';
import { deepEqual } from '../utils/equality';
import { warn } from '../utils/dev';
import {
  ReactiveFlags,
  hasChanged,
  isArray,
  isFunction,
  isMap,
  isObject,
  isSet,
} from '../utils/shared';

export type WatchSource<T = unknown> = Ref<T> | ComputedRef<T> | (() => T);

export interface WatchOptions {
  /** Runs the callback once right away (with `undefined`/`[]` as the old value). */
  immediate?: boolean;
  /** Traverses the source so nested mutations are tracked. Implied by a reactive object source. */
  deep?: boolean;
  /** When the callback runs. Defaults to `'pre'`. */
  flush?: FlushMode;
  /** Scope to attach to instead of the currently active one. */
  scope?: EffectScope;
}

export interface WatchEffectOptions {
  /** When the effect runs. Defaults to `'pre'`. */
  flush?: FlushMode;
  /** Scope to attach to instead of the currently active one. */
  scope?: EffectScope;
}

export type WatchCallback<T = unknown, O = T> = (
  value: T,
  oldValue: O,
  onCleanup: OnCleanup,
) => void;

/** Callable stop handle returned by `watch()`/`watchEffect()`. */
export type WatchHandle = EffectHandle;

type UntypedSource = Ref<unknown> | ComputedRef<unknown> | (() => unknown) | object;

/** Reads every nested property of `value` so a watcher subscribes to the whole tree. */
export function traverse(value: unknown, seen?: Set<unknown>): unknown {
  if (!isObject(value) || (value as Record<string, unknown>)[ReactiveFlags.SKIP] === true) {
    return value;
  }
  const visited = seen ?? new Set<unknown>();
  if (visited.has(value)) return value;
  visited.add(value);

  if (isRef(value)) {
    traverse(value.value, visited);
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) traverse(value[i], visited);
  } else if (isMap(value) || isSet(value)) {
    value.forEach((entry) => traverse(entry, visited));
  } else {
    for (const key in value) traverse((value as Record<string, unknown>)[key], visited);
  }

  visited.delete(value);
  return value;
}

function sourceChanged(next: unknown, previous: unknown, deep: boolean): boolean {
  if (!deep) return hasChanged(next, previous);
  // A deep source that kept its identity was re-run by a nested mutation.
  if (Object.is(next, previous)) return true;
  return !deepEqual(next, previous);
}

export function watch<T>(
  source: WatchSource<T> | object,
  callback: WatchCallback<T>,
  options?: WatchOptions,
): WatchHandle;
export function watch(
  source: ReadonlyArray<UntypedSource>,
  callback: WatchCallback<unknown[]>,
  options?: WatchOptions,
): WatchHandle;
export function watch(
  source: unknown,
  callback: WatchCallback<any, any>,
  options: WatchOptions = {},
): WatchHandle {
  const flush: FlushMode = options.flush ?? 'pre';
  let deep = options.deep === true;
  let isMultiSource = false;
  // Per-entry deep flag for array sources: a reactive object is observable only through traversal,
  // and its reference never changes, so the element-wise comparison has to be structural for it.
  const deepEntries: boolean[] = [];
  let getter: () => unknown;

  if (isRef(source)) {
    getter = () => (source as Ref<unknown>).value;
  } else if (isReactive(source)) {
    // Watching a reactive object means watching everything it holds.
    deep = true;
    getter = () => source;
  } else if (isArray(source)) {
    isMultiSource = true;
    const sources = source as UntypedSource[];
    getter = () =>
      sources.map((item, index) => {
        if (isRef(item)) return item.value;
        if (isFunction(item)) return (item as () => unknown)();
        if (isReactive(item)) {
          deepEntries[index] = true;
          return traverse(item);
        }
        // Anything else cannot be observed at all: accepting it silently would produce a source that
        // never reports a change, so the callback would look broken with no hint why.
        warn(
          'watch(): an array source must contain refs, getters or reactive objects; this entry ' +
            'cannot be observed and its changes are ignored.',
        );
        return item as unknown;
      });
  } else if (isFunction(source)) {
    getter = source as () => unknown;
  } else {
    throw new TypeError(
      'watch() expects a ref, a getter, a reactive object or an array of sources.',
    );
  }

  if (deep) {
    const readSource = getter;
    getter = () => traverse(readSource());
  }

  let oldValue: unknown = isMultiSource ? [] : undefined;
  let cleanup: EffectCleanup | null = null;
  const onCleanup: OnCleanup = (fn) => {
    cleanup = fn;
  };

  const instance = new ReactiveEffect<unknown>(getter, { flush, scope: options.scope });

  const runCleanup = (): void => {
    if (cleanup === null) return;
    const fn = cleanup;
    cleanup = null;
    fn();
  };

  const job = (): void => {
    if (!instance.active) return;
    runCleanup();
    const newValue = instance.run();
    if (instance.paused) return;
    const changed = isMultiSource
      ? (isArray(newValue) ? newValue : []).some((value, index) =>
          sourceChanged(
            value,
            (isArray(oldValue) ? oldValue : [])[index],
            deep || deepEntries[index] === true,
          ),
        )
      : sourceChanged(newValue, oldValue, deep);
    if (!changed) return;
    callback(newValue, oldValue, onCleanup);
    oldValue = newValue;
  };

  instance.job = job;
  instance.onStop = runCleanup;

  if (options.immediate === true) job();
  else oldValue = instance.run();

  return toEffectHandle(instance);
}

/**
 * Runs `fn` immediately, tracks every reactive value it read, and re-runs it when one of them
 * changes. `fn` receives `onCleanup`, which runs before the next run and on stop.
 */
export function watchEffect(
  fn: (onCleanup: OnCleanup) => void,
  options: WatchEffectOptions = {},
): WatchHandle {
  const instance = new ReactiveEffect<void>(fn, {
    flush: options.flush ?? 'pre',
    scope: options.scope,
  });
  instance.run();
  return toEffectHandle(instance);
}

/** `watchEffect` variant that runs after the `pre` lane (batched side effects, DOM-ish work). */
export function watchPostEffect(
  fn: (onCleanup: OnCleanup) => void,
  options: WatchEffectOptions = {},
): WatchHandle {
  return watchEffect(fn, { ...options, flush: 'post' });
}

/** `watchEffect` variant that re-runs synchronously on every change. */
export function watchSyncEffect(
  fn: (onCleanup: OnCleanup) => void,
  options: WatchEffectOptions = {},
): WatchHandle {
  return watchEffect(fn, { ...options, flush: 'sync' });
}
