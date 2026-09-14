/**
 * The binding layer of the adapter (PLAN §4.4, milestone M6): views kept in sync with reactive state.
 *
 * Design:
 * - every binding runs as an effect owned by the target widget's `scope`, so destroying the widget
 *   stops its bindings (no stale subscribers, no manual bookkeeping);
 * - the default flush mode is `'frame'`: the scene plugin calls `flushFrame()` once per frame before
 *   layout, so N state changes in a frame cost exactly one repaint and one layout pass (ADR-0008);
 * - bindings are pull-through and short-circuiting: the getter is evaluated on every run, and the
 *   applied value is compared with the previous one, so an unchanged value never touches the widget.
 *
 * Path resolution comes from `@phaser-mvvm/core`'s binding layer: `compilePath` (plain string
 * parsing, **no `eval`/`new Function`**) plus `parseInterpolation`/`formatTemplate` for `{{ … }}`
 * templates. This module is the only Phaser-aware half — it maps a context onto a widget.
 */

import {
  compilePath,
  createBinding,
  formatTemplate,
  isBindingContext,
  parseInterpolation,
} from '@phaser-mvvm/core';
import type {
  BindingContext,
  BindingScope,
  CompiledPath,
  FlushMode,
  PathScope,
  StopBinding,
  TemplateScope,
} from '@phaser-mvvm/core';
import type { ActivationSource, Widget } from './Widget';

export type BindingFlush = 'sync' | 'pre' | 'post' | 'frame';

export interface BindingOptions {
  flush?: BindingFlush;
}

export type { StopBinding };

/** Anything a binding can read paths from: a `BindingContext` or a raw scope object. */
export type BindingTarget = BindingContext | PathScope;

/** A command getter: returns the function to run, or nothing when the command is unavailable. */
export type CommandGetter = () => ((...args: unknown[]) => unknown) | null | undefined;

/** `true` when a runtime argument is a binding target (a command getter is always a function). */
function isBindingTarget(value: unknown): value is BindingTarget {
  return typeof value === 'object' && value !== null;
}

/**
 * The plain scope object the expression compiler walks.
 *
 * `BindingContext` already builds (and caches) one per level, so a binding never copies the view
 * model: reading a path still goes through the original object, which is what keeps reactive
 * tracking (`ref`, `computed`, `reactive`) working inside the binding effect.
 */
export function bindingScopeOf(target: BindingTarget): PathScope {
  return isBindingContext(target) ? target.scopeNode : target;
}

/** A `TemplateScope` that compiles each `{{ … }}` path once and reads it through the target. */
export function templateScopeOf(target: BindingTarget): TemplateScope {
  const scope = bindingScopeOf(target);
  const cache = new Map<string, CompiledPath>();
  return {
    resolve(path: string): unknown {
      let compiled = cache.get(path);
      if (compiled === undefined) {
        compiled = compilePath(path);
        cache.set(path, compiled);
      }
      return compiled.get(scope);
    },
  };
}

function flushOf(options: BindingOptions): FlushMode {
  return options.flush ?? 'frame';
}

/**
 * Runs `apply(read())` inside `host.scope`, immediately and then whenever the reactive state read by
 * `read` changes. Returns a stop function (the widget's destruction also stops it).
 *
 * The applied value is compared with the previous one (`Object.is`), so an unchanged value is never
 * written back — the short-circuit ADR-0008 §5 asks for in two-way flows.
 */
export function bindValue<T>(
  host: Widget,
  read: () => T,
  apply: (value: T, host: Widget) => void,
  options: BindingOptions = {},
): StopBinding {
  return createBinding<T, Widget>({
    host,
    read,
    apply,
    flush: flushOf(options),
  });
}

/**
 * Binds a single path of a binding context to a widget.
 *
 * ```ts
 * bindPath(rowLabel, context, '$item.name', (value, widget) => widget.setText(String(value)));
 * ```
 */
export function bindPath<T = unknown>(
  host: Widget,
  context: BindingTarget,
  path: string,
  apply: (value: T, host: Widget) => void,
  options: BindingOptions = {},
): StopBinding {
  const scope = bindingScopeOf(context);
  const compiled = compilePath(path);
  return bindValue<T>(host, () => compiled.get(scope) as T, apply, options);
}

/**
 * Binds an interpolated template (`'共 {{ items.length }} 项'`) to a widget.
 *
 * The template is parsed once; every dependency read while formatting re-runs the binding on the
 * next flush.
 */
export function bindTemplate(
  host: Widget,
  context: BindingTarget,
  template: string,
  apply: (text: string, host: Widget) => void,
  options: BindingOptions = {},
): StopBinding {
  const segments = parseInterpolation(template);
  const scope = templateScopeOf(context);
  return bindValue<string>(host, () => formatTemplate(scope, segments), apply, options);
}

/** Binds a label's text (works with anything exposing `setText`). */
export function bindText(
  host: Widget & { setText(value: string): unknown },
  read: () => string,
  options: BindingOptions = {},
): StopBinding {
  return bindValue(
    host,
    read,
    (value, widget) => {
      (widget as Widget & { setText(v: string): unknown }).setText(String(value ?? ''));
    },
    options,
  );
}

/** Binds an interpolated template to anything exposing `setText` (usually a `Label`). */
export function bindTemplateText(
  host: Widget & { setText(value: string): unknown },
  context: BindingTarget,
  template: string,
  options: BindingOptions = {},
): StopBinding {
  return bindTemplate(
    host,
    context,
    template,
    (text, widget) => {
      (widget as unknown as { setText(value: string): unknown }).setText(text);
    },
    options,
  );
}

/** Binds visibility through the layout engine (hidden widgets collapse out of the flow). */
export function bindVisible(
  host: Widget,
  read: () => boolean,
  options: BindingOptions = {},
): StopBinding {
  return bindValue(
    host,
    read,
    (value, widget) => {
      widget.setVisible(value !== false);
    },
    options,
  );
}

/** Binds the enabled state (drives the `disabled` visual state and input handling). */
export function bindEnabled(
  host: Widget,
  read: () => boolean,
  options: BindingOptions = {},
): StopBinding {
  return bindValue(
    host,
    read,
    (value, widget) => {
      widget.setEnabled(value !== false);
    },
    options,
  );
}

/** Binds an error/validation state (drives the `error` visual state). */
export function bindError(
  host: Widget,
  read: () => boolean,
  options: BindingOptions = {},
): StopBinding {
  return bindValue(
    host,
    read,
    (value, widget) => {
      widget.setError(value === true);
    },
    options,
  );
}

export interface CommandBindingOptions extends BindingOptions {
  /** When it returns `false` the host is disabled (`canExecute` semantics). */
  canExecute?: () => boolean;
}

/** Command binding driven by a context: both the command and its `canExecute` are paths. */
export interface PathCommandBindingOptions extends BindingOptions {
  /**
   * Path resolving to the `canExecute` flag (`'form.valid'`), or a plain getter. Either way the
   * host's enabled state follows it reactively.
   */
  canExecute?: string | (() => boolean);
}

/**
 * Binds an activation callback to a command getter.
 *
 * `read` returns the command to run (or `null`/`undefined` for "nothing to do"); when `canExecute`
 * is provided the host's enabled state follows it. Any pre-existing `onActivate` handler is chained,
 * not replaced.
 */
export function bindCommand(
  host: Widget,
  read: CommandGetter,
  options?: CommandBindingOptions,
): StopBinding;
/**
 * Binds an activation callback to a command **path** of a binding context.
 *
 * ```ts
 * bindCommand(saveButton, context, 'commands.save', { canExecute: 'form.valid' });
 * ```
 */
export function bindCommand(
  host: Widget,
  context: BindingTarget,
  source: string | CommandGetter,
  options?: PathCommandBindingOptions,
): StopBinding;
export function bindCommand(
  host: Widget,
  contextOrRead: BindingTarget | CommandGetter,
  sourceOrOptions?: string | CommandGetter | CommandBindingOptions,
  maybeOptions?: PathCommandBindingOptions,
): StopBinding {
  if (isBindingTarget(contextOrRead)) {
    const scope = bindingScopeOf(contextOrRead);
    const source = sourceOrOptions as string | CommandGetter;
    const options = maybeOptions ?? {};
    const compiledSource = typeof source === 'string' ? compilePath(source) : null;
    const read: CommandGetter =
      compiledSource === null
        ? (source as CommandGetter)
        : () => compiledSource.get(scope) as ReturnType<CommandGetter>;

    const canExecute = options.canExecute;
    const compiledCanExecute = typeof canExecute === 'string' ? compilePath(canExecute) : null;
    return bindCommandWith(host, read, {
      flush: options.flush,
      canExecute:
        compiledCanExecute === null
          ? (canExecute as (() => boolean) | undefined)
          : () => Boolean(compiledCanExecute.get(scope)),
    });
  }
  return bindCommandWith(
    host,
    contextOrRead,
    (sourceOrOptions as CommandBindingOptions | undefined) ?? {},
  );
}

function bindCommandWith(
  host: Widget,
  read: CommandGetter,
  options: CommandBindingOptions,
): StopBinding {
  const previous = host.onActivate;
  const installed = (source: ActivationSource): void => {
    previous?.(source);
    const command = read();
    command?.();
  };
  host.onActivate = installed;

  // A widget that carries a command has to become a pointer target even when it declares nothing else.
  // `collectInteractive()` picks a widget up because of `onActivate`, but two things were missing for a
  // plain `Label`/`Image`/`Divider`: it had no hit area at all, and the router's collection ran when the
  // tree was mounted - binding a command afterwards changed no structure, so nothing ever re-collected.
  // Giving it a hit area and nudging the structure listener (the signal the plugin watches for "the
  // interactive set may have changed") fixes both without the caller writing `interactive: true`.
  host.enablePointerInput?.();
  host.structureListener?.();

  let stopCanExecute: StopBinding | null = null;
  if (options.canExecute) {
    const canExecute = options.canExecute;
    stopCanExecute = bindEnabled(host, canExecute, options);
  }

  return () => {
    stopCanExecute?.();
    // Only restore when this binding's handler is still installed: a handler bound *after* it must not
    // be wiped out by stopping the older binding.
    if (host.onActivate === installed) {
      host.onActivate = previous;
    }
  };
}

/** The slice of a text control `bindModel` needs (satisfied by `TextField` and `TextArea`). */
export interface ModelBindingHost extends BindingScope {
  /** Programmatic, *silent* write: it must not emit `change`. */
  setValue(value: string): unknown;
  /** Current value of the control. */
  getValue(): string;
  /** Subscribes to the control's `change` event. */
  on(event: string, callback: (value: string) => void): unknown;
  /** Unsubscribes (Phaser's `GameObject.off`). */
  off?(event: string, callback: (value: string) => void): unknown;
  /** `true` while an IME composition is open; write-back is paused then (PLAN §4.4). */
  readonly composing?: boolean;
}

/** Event a text control emits after a *user* edit. */
export const MODEL_CHANGE_EVENT = 'change';

/**
 * Host shape of a control whose value is typed rather than text (a slider, a toggle).
 *
 * Same protocol as {@link ModelBindingHost}, minus the text conversion: `bindModel` stringifies, which
 * would write `"42"` back into a numeric `ref` and `"false"` back into a boolean one.
 */
export interface ValueModelHost<T> extends BindingScope {
  /** Programmatic, *silent* write: it must not emit `change`. */
  setValue(value: T): unknown;
  /** Current value of the control. */
  getValue(): T;
  /** Subscribes to the control's `change` event. */
  on(event: string, callback: (value: T) => void): unknown;
  /** Unsubscribes (Phaser's `GameObject.off`). */
  off?(event: string, callback: (value: T) => void): unknown;
}

/** A numeric control's host ({@link ValueModelHost} specialised to `number`). */
export type NumberModelHost = ValueModelHost<number>;

/** A boolean control's host ({@link ValueModelHost} specialised to `boolean`). */
export type BooleanModelHost = ValueModelHost<boolean>;

/**
 * Two-way binding for a non-text control, keeping the value's type in both directions.
 *
 * - **down**: `read()` is applied through the control's *silent* `setValue`, so a programmatic write
 *   never looks like a user edit and the write-back loop stops there (ADR-0008 §5);
 * - **up**: the control's `change` event (user interaction only) writes back, short-circuiting when the
 *   value already matches `read()`;
 * - `Object.is` is the change test, so `-0`/`NaN` cannot produce an endless ping-pong.
 */
export function bindValueModel<T>(
  host: ValueModelHost<T>,
  read: () => T,
  write: (value: T) => void,
  options: BindingOptions = {},
): StopBinding {
  const stopDown = createBinding<T, ValueModelHost<T>>({
    host,
    read,
    apply: (value) => {
      if (Object.is(host.getValue(), value)) {
        return;
      }
      host.setValue(value);
    },
    flush: flushOf(options),
  });

  const listener = (value: T): void => {
    if (Object.is(value, read())) {
      return;
    }
    write(value);
  };

  host.on(MODEL_CHANGE_EVENT, listener);

  return () => {
    stopDown();
    host.off?.(MODEL_CHANGE_EVENT, listener);
  };
}

/**
 * Two-way binding for a numeric control (`Slider`).
 *
 * A named shorthand for {@link bindValueModel}: the call site reads better than a type argument.
 */
export function bindNumberModel(
  host: NumberModelHost,
  read: () => number,
  write: (value: number) => void,
  options: BindingOptions = {},
): StopBinding {
  return bindValueModel<number>(host, read, write, options);
}

/** Two-way binding for a boolean control (a `toggle` button). */
export function bindBooleanModel(
  host: BooleanModelHost,
  read: () => boolean,
  write: (value: boolean) => void,
  options: BindingOptions = {},
): StopBinding {
  return bindValueModel<boolean>(host, read, write, options);
}

/**
 * Two-way binding for text controls: view model ⇄ `TextField`/`TextArea`.
 *
 * - **down**: `read()` is applied through the control's *silent* `setValue`, so a programmatic write
 *   never looks like a user edit and the loop stops there (ADR-0008 §5);
 * - **up**: the control's `change` event (user edits only) writes back, short-circuiting when the
 *   value already matches `read()`;
 * - both directions live in `host.scope`, and stopping the binding also detaches the listener.
 *
 * While an IME composition is open the write-back is paused: intermediate states would corrupt the
 * model (PLAN §4.4).
 */
export function bindModel(
  host: ModelBindingHost,
  read: () => string,
  write: (value: string) => void,
  options: BindingOptions = {},
): StopBinding {
  const text = (value: unknown): string =>
    value === null || value === undefined ? '' : String(value);

  const stopDown = createBinding<string, ModelBindingHost>({
    host,
    read: () => text(read()),
    apply: (value) => {
      if (host.getValue() === value) {
        return;
      }
      host.setValue(value);
    },
    flush: flushOf(options),
  });

  const listener = (value: string): void => {
    if (host.composing === true) {
      return;
    }
    const next = text(value);
    if (next === text(read())) {
      return;
    }
    write(next);
  };

  host.on(MODEL_CHANGE_EVENT, listener);

  return () => {
    stopDown();
    host.off?.(MODEL_CHANGE_EVENT, listener);
  };
}
