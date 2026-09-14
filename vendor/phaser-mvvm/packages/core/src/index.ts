/**
 * `@phaser-mvvm/core` — the reactive kernel of phaser-mvvm.
 *
 * The public surface is grouped as:
 * - state: `ref`, `shallowRef`, `reactive`, `shallowReactive`, `readonly`, `makeObservable`
 * - derived state: `computed`
 * - effects: `effect`, `watch`, `watchEffect`, `effectScope`
 * - scheduling: `nextTick`, `flushSync`, `flushFrame`, `configureScheduler`
 * - utilities: `toRaw`, `isRef`, `untrack`, `markRaw`, `deepEqual`, dev-mode warnings
 *
 * Nothing here imports Phaser; the adapter layer registers `configureScheduler()` to align `pre`
 * and `post` flushes with the game loop and calls `flushFrame()` from its per-frame sync point.
 */

// Reactive state -------------------------------------------------------------------------------
export {
  reactive,
  shallowReactive,
  readonly,
  shallowReadonly,
  isReactive,
  isReadonly,
  isProxy,
  toRaw,
  toReactive,
  markRaw,
  ITERATE_KEY,
  getDepSize,
} from './reactivity/reactive';
export type { DeepReadonly } from './reactivity/reactive';

export { ref, shallowRef, isRef, unref, triggerRef, customRef } from './reactivity/ref';
export type { Ref, ShallowRef, CustomRefFactory } from './reactivity/ref';

export { computed, ComputedRefImpl } from './reactivity/computed';
export type { ComputedRef, ComputedOptions } from './reactivity/computed';

export { makeObservable, observableUnit } from './reactivity/observable';
export type { ObservableKind, ObservableSpec } from './reactivity/observable';

// Effects, scopes and watchers ------------------------------------------------------------------
export { effect, ReactiveEffect, toEffectHandle } from './reactivity/effect';
export type {
  EffectCleanup,
  EffectFn,
  EffectHandle,
  EffectOptions,
  OnCleanup,
} from './reactivity/effect';

export { effectScope, getCurrentScope, onScopeDispose } from './reactivity/scope';
export type { EffectScope } from './reactivity/scope';

export { watch, watchEffect, watchPostEffect, watchSyncEffect, traverse } from './reactivity/watch';
export type {
  WatchCallback,
  WatchEffectOptions,
  WatchHandle,
  WatchOptions,
  WatchSource,
} from './reactivity/watch';

// Dependency primitives --------------------------------------------------------------------------
export {
  Dep,
  cleanupDeps,
  getActiveSub,
  isTracking,
  pauseNotifications,
  pauseTracking,
  resumeNotifications,
  resumeTracking,
  setActiveSub,
  untrack,
} from './reactivity/dep';
export type { Subscriber } from './reactivity/dep';

// Bindings (PLAN §4.4): path compiler, scope chain, converters, interpolated templates ------------
export {
  PathSyntaxError,
  SCOPE_VM,
  compilePath,
  isPathScope,
  parsePath,
} from './binding/expression';
export type { CompiledPath, PathScope } from './binding/expression';

export { BindingContext, isBindingContext } from './binding/context';
export type {
  BindingContextOptions,
  BindingSource,
  ChildScopeVars,
  ScopeNodeFactory,
} from './binding/context';

export {
  BUILT_IN_CONVERTERS,
  applyConverter,
  converterNames,
  hasConverter,
  installBuiltInConverters,
  registerConverter,
  resetConverters,
  unregisterConverter,
} from './binding/converter';
export type { Converter } from './binding/converter';

export {
  TemplateSyntaxError,
  compileTemplate,
  formatTemplate,
  interpolate,
  parseInterpolation,
  scopeOfPathScope,
} from './binding/template';
export type {
  ExpressionSegment,
  TemplateConverter,
  TemplateScope,
  TemplateSegment,
  TemplateSource,
  TextSegment,
} from './binding/template';

export { createBinding } from './binding/binding';
export type {
  BindingScope,
  CreateBindingOptions,
  EffectScopeLike,
  StopBinding,
} from './binding/binding';

// Scheduler --------------------------------------------------------------------------------------
export {
  configureScheduler,
  flushFrame,
  flushSync,
  getSchedulerHooks,
  hasPendingFrameJobs,
  hasPendingJobs,
  nextTick,
  queueJob,
} from './reactivity/scheduler';
export type { FlushMode, SchedulerHooks, SchedulerJob } from './reactivity/scheduler';

// Utilities and development helpers --------------------------------------------------------------
export { deepEqual } from './utils/equality';
export { LruCache } from './utils/lru';
export {
  devLog,
  RECURSION_LIMIT,
  isDevMode,
  onDevWarning,
  resetDevWarnings,
  setDevMode,
  warn,
} from './utils/dev';
export type { DevWarningHandler } from './utils/dev';
export { ReactiveFlags, hasChanged } from './utils/shared';
