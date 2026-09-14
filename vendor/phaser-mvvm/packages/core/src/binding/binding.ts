/**
 * The renderer-agnostic half of the binding layer (PLAN §4.4, ADR-0008).
 *
 * A binding is an `effect` that reads reactive state and pushes the result into a host object. Two
 * decisions matter and live here rather than in the adapter:
 *
 * - **ownership**: the effect joins `host.scope`, so destroying the host (a widget) stops every
 *   binding attached to it — no stale subscribers, no manual bookkeeping;
 * - **short-circuit**: the applied value is compared with the previous one and skipped when equal,
 *   which is what keeps a two-way flow from oscillating (ADR-0008 §5).
 *
 * `BindingScope` only asks for `{ scope }`, so `core` never has to mention Phaser: the adapter's
 * `Widget` satisfies it structurally and the `widgets` package can use the same primitive.
 */

import type { EffectScope } from '../reactivity/scope';
import type { FlushMode } from '../reactivity/scheduler';
import { effect } from '../reactivity/effect';

/** Anything that owns an `EffectScope` and therefore can host bindings. */
export interface BindingScope {
  readonly scope: EffectScope;
}

/** Alias kept for call sites that prefer the explicit name. */
export type EffectScopeLike = BindingScope;

/** Stops a single binding; calling it twice is harmless. */
export type StopBinding = () => void;

export interface CreateBindingOptions<T, H extends BindingScope = BindingScope> {
  /** Owner of the binding; the effect lives in `host.scope`. */
  host: H;
  /** Reactive getter, evaluated once per flush and on every dependency change. */
  read: () => T;
  /** Receives the value whenever it changed. */
  apply: (value: T, host: H) => void;
  /** Scheduler lane. UI bindings default to `'frame'` (ADR-0008 §3). */
  flush?: FlushMode;
  /** Equality used to skip `apply`; defaults to `Object.is`. */
  equals?: (a: T, b: T) => boolean;
}

/**
 * Creates a pull-through binding and returns its stop handle.
 *
 * The getter runs immediately (the host is synchronised at creation time) and then once per flush
 * whenever a dependency changed. `apply` is skipped when the new value equals the last applied one.
 */
export function createBinding<T, H extends BindingScope = BindingScope>(
  options: CreateBindingOptions<T, H>,
): StopBinding {
  const { host, read, apply } = options;
  const equals = options.equals ?? Object.is;
  let hasValue = false;
  let previous: T | undefined;

  const handle = effect(
    () => {
      const value = read();
      if (hasValue && equals(previous as T, value)) {
        return;
      }
      hasValue = true;
      previous = value;
      apply(value, host);
    },
    { scope: host.scope, flush: options.flush ?? 'frame' },
  );

  return () => handle.stop();
}
