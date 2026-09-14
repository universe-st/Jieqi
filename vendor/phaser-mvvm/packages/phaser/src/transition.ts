/**
 * Open/close motion: the fade a dialog plays when it appears and when it goes away (PLAN M8's
 * 开闭动效, generalised into a small runner any layer can use).
 *
 * The whole module is **pure logic plus one structural interface** — no Phaser import, not even a
 * type-only one — so the scheduling half is unit-tested in Node with a fake target
 * (`test/transition.test.ts`), the way `reveal.ts` and `back-plan.ts` are. The parts that need a real
 * widget are three methods wide (`alpha`, `scaleX/scaleY`, `setAlpha`, `setScale`), which a Phaser
 * `Container` already satisfies.
 *
 * Two decisions worth knowing before reading:
 *
 * 1. **Time comes from the caller.** `step(delta)` is fed the scene's own frame delta, not
 *    `Date.now()` and not a Phaser tween. A tween would have to be created and killed per dialog and
 *    would show up in the lifecycle counters (`tweens`), and wall-clock time makes the animation jump
 *    after a tab switch. The plugin already walks frames for the reveal pass, so transitions ride the
 *    same hook — and a paused scene freezes them instead of skipping them.
 * 2. **`'base'` endpoints.** A transition says "from 0 to whatever this widget's own value is", which
 *    is what makes the same spec work for the scrim (whose opacity is `scrim` option, not `1`) and for
 *    the dialog body. The runner captures the target's values when the run starts.
 */

/** The easing curves a transition may name. */
export type EasingName = 'linear' | 'inCubic' | 'outCubic' | 'inOutCubic';

/** Maps `0`…`1` to `0`…`1` (clamped input, monotonic output). */
export type Easing = (t: number) => number;

/** The built-in curves. Deliberately four: cubic in/out covers the whole UI vocabulary. */
export const EASINGS: Readonly<Record<EasingName, Easing>> = {
  linear: (t) => t,
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

/** One end of an animated property: a number, or `'base'` = the target's own value at run start. */
export type Endpoint = number | 'base';

/** Which properties a run touches. */
export type TransitionProp = 'alpha' | 'scale';

/**
 * A fully resolved animation.
 *
 * `[from, to]` pairs are `null` when that property is not animated at all — which is how the scrim
 * stays a pure fade while the dialog body fades *and* scales.
 */
export interface ResolvedTransition {
  /** Milliseconds; `0` means "no animation, apply the end state now". */
  duration: number;
  easing: EasingName;
  /** Milliseconds to hold before the first step. Defaults to `0`. */
  delay: number;
  alpha: readonly [Endpoint, Endpoint] | null;
  scale: readonly [Endpoint, Endpoint] | null;
}

/** What a caller may write in place of a resolved transition, at either level. */
export interface TransitionSpec {
  /** Milliseconds; `0` (or `false` as a whole spec) disables the animation. */
  duration?: number;
  easing?: EasingName;
  delay?: number;
  /** Opacity to start from; omit to keep the target's own. */
  fromAlpha?: number;
  /** Opacity to end on. Omit for the target's own alpha (the usual choice for an enter). */
  toAlpha?: number;
  /** Scale to start from; omit to keep the target's own. */
  fromScale?: number;
  /** Scale to end on. Omit for the target's own scale. */
  toScale?: number;
}

/** A transition written as "just a duration" (or `false` for none) is accepted everywhere. */
export type TransitionInput = TransitionSpec | number | false;

/** The plugin-level motion policy (`MVVMPlugin.configure({ transition: … })`). */
export interface TransitionOptions {
  /** Master switch. `false` disables every built-in animation. Defaults to `true`. */
  enabled?: boolean;
  /** The appear animation of a layer. Defaults to `160` ms of `outCubic`. */
  enter?: TransitionInput;
  /** The disappear animation of a layer. Defaults to `120` ms of `inCubic`, then the layer is freed. */
  exit?: TransitionInput;
  /**
   * Collapse every animation to `0` ms while the OS asks for reduced motion
   * (`prefers-reduced-motion: reduce`). Defaults to `true`: honouring it is the accessible default,
   * and an app that wants its motion regardless can say so.
   */
  respectReducedMotion?: boolean;
}

/**
 * The theme's motion tokens (`Theme.motion`), passed in rather than imported so this module stays free
 * of the theme (and of Phaser): a theme decides how long a thing takes, this decides what happens.
 */
export interface MotionTokens {
  /** Milliseconds for an appearing layer or page. */
  enter: number;
  /** Milliseconds for a disappearing layer or page. */
  exit: number;
}

/** A per-layer override; `true`/`false` mean "use the policy" / "no animation at all". */
export type TransitionOverride =
  boolean | Omit<TransitionOptions, 'enabled' | 'respectReducedMotion'>;

/** The motion policy with every default filled in, ready for `TransitionRunner#run`. */
export interface ResolvedTransitions {
  /** `false` when the policy (or a per-layer `false`) turned motion off. */
  enabled: boolean;
  /** `true` when the durations were collapsed because the OS asked for reduced motion. */
  reduced: boolean;
  enter: ResolvedTransition;
  exit: ResolvedTransition;
}

/** Default appear animation: a short fade with a slight grow. */
export const DEFAULT_ENTER: TransitionSpec = {
  duration: 160,
  easing: 'outCubic',
  fromAlpha: 0,
  fromScale: 0.96,
};

/** Default disappear animation: shorter than the enter, so closing never feels sticky. */
export const DEFAULT_EXIT: TransitionSpec = {
  duration: 120,
  easing: 'inCubic',
  toAlpha: 0,
  toScale: 0.98,
};

/** Where a dialog's appear/disappear durations are documented (and checked) once. */
export const DEFAULT_TRANSITION_OPTIONS: Required<
  Pick<TransitionOptions, 'enabled' | 'enter' | 'exit'>
> &
  TransitionOptions = {
  enabled: true,
  enter: DEFAULT_ENTER,
  exit: DEFAULT_EXIT,
  respectReducedMotion: true,
};

/** A transition with no duration: the runner applies the end state and schedules nothing. */
export const INSTANT: ResolvedTransition = {
  duration: 0,
  easing: 'linear',
  delay: 0,
  alpha: null,
  scale: null,
};

/** Easing lookup that never throws: an unknown name falls back to `linear` (and is a type error). */
export function easingOf(name: EasingName | undefined): Easing {
  return EASINGS[name ?? 'linear'] ?? EASINGS.linear;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalises one written spec (+ the built-in default it extends) into a resolved transition.
 *
 * `false` wins over everything (an explicit "no animation"), and so does `duration: 0`; a negative or
 * non-finite duration is treated as `0` rather than as a runaway animation.
 */
export function resolveTransition(
  input: TransitionInput | undefined,
  fallback: TransitionSpec,
  disabled = false,
): ResolvedTransition {
  if (disabled || input === false) {
    return INSTANT;
  }
  const spec: TransitionSpec =
    typeof input === 'number' ? { duration: input } : (input ?? fallback);
  const merged: TransitionSpec = { ...fallback, ...spec };

  const rawDuration = merged.duration ?? fallback.duration ?? 0;
  const duration = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;
  const delay = Math.max(0, Number.isFinite(merged.delay) ? (merged.delay as number) : 0);
  const easing = merged.easing ?? fallback.easing ?? 'linear';
  if (duration === 0) {
    // A zero duration still keeps the *end* state (an instant enter must land on the final opacity,
    // an instant exit on its `to`), so the properties are carried through with a collapsed range.
    return {
      duration: 0,
      easing,
      delay: 0,
      alpha: alphaEndpoints(merged),
      scale: scaleEndpoints(merged),
    };
  }
  return {
    duration,
    easing,
    delay,
    alpha: alphaEndpoints(merged),
    scale: scaleEndpoints(merged),
  };
}

function alphaEndpoints(spec: TransitionSpec): readonly [Endpoint, Endpoint] | null {
  if (spec.fromAlpha === undefined && spec.toAlpha === undefined) {
    return null;
  }
  return [spec.fromAlpha ?? 'base', spec.toAlpha ?? 'base'];
}

function scaleEndpoints(spec: TransitionSpec): readonly [Endpoint, Endpoint] | null {
  if (spec.fromScale === undefined && spec.toScale === undefined) {
    return null;
  }
  return [spec.fromScale ?? 'base', spec.toScale ?? 'base'];
}

/**
 * Resolves the whole policy for one layer: the plugin config, the optional per-layer override, and
 * what the OS asked for.
 *
 * A per-layer `false` and `enabled: false` both collapse to {@link INSTANT}, but they are recorded
 * differently (`enabled: false`), because the dev trace prints which one it was.
 *
 * `motion` is the theme's duration token pair: it replaces the *duration* of the built-in defaults and
 * nothing else, so an easing written in a spec survives a theme swap and an explicit duration still
 * wins over the token.
 */
export function resolveTransitions(
  options: TransitionOptions | false | undefined,
  override: TransitionOverride | undefined,
  reducedMotion: boolean,
  motion?: MotionTokens,
): ResolvedTransitions {
  const base: TransitionOptions = options === false ? { enabled: false } : (options ?? {});
  // The theme owns the durations; `DEFAULT_ENTER`/`DEFAULT_EXIT` keep the easing and the endpoints.
  const enterFallback: TransitionSpec = motion
    ? { ...DEFAULT_ENTER, duration: motion.enter }
    : DEFAULT_ENTER;
  const exitFallback: TransitionSpec = motion
    ? { ...DEFAULT_EXIT, duration: motion.exit }
    : DEFAULT_EXIT;
  const explicitOff = override === false || base.enabled === false;
  const overrides: Omit<TransitionOptions, 'enabled' | 'respectReducedMotion'> =
    override === undefined || typeof override === 'boolean' ? {} : override;

  const reduced = Boolean(
    base.respectReducedMotion !== false && reducedMotion && override !== false,
  );
  const disabled = explicitOff || reduced;

  return {
    enabled: !explicitOff,
    reduced,
    enter: resolveTransition(overrides.enter ?? base.enter, enterFallback, disabled),
    exit: resolveTransition(overrides.exit ?? base.exit, exitFallback, disabled),
  };
}

/**
 * Whether the page asks for reduced motion.
 *
 * `window` is a parameter so this stays callable (and testable) outside a browser: it is the only
 * impure function in the module, and it answers `false` whenever there is nothing to ask.
 */
export function prefersReducedMotion(win: Window | undefined = defaultWindow()): boolean {
  if (!win || typeof win.matchMedia !== 'function') {
    return false;
  }
  try {
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    // A locked-down environment can throw here; a UI that cannot ask still has to render.
    return false;
  }
}

function defaultWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

/** The slice of a widget a transition touches. A Phaser `Container` satisfies it structurally. */
export interface TransitionTarget {
  readonly alpha: number;
  readonly scaleX: number;
  readonly scaleY: number;
  setAlpha(value: number): unknown;
  setScale(x: number, y: number): unknown;
  /** Phaser sets this in `destroy()`; an object literal in a test may omit it. */
  readonly isDestroyed?: boolean;
}

/** The two widgets a modal animates: its veil and its panel. */
export interface ModalTransitionParts {
  /** `null` when the dialog was opened with `scrim: 0` (no veil to fade). */
  readonly scrim: TransitionTarget | null;
  readonly content: TransitionTarget;
}

/**
 * The runs one modal transition needs: the veil fades, the panel fades **and** scales.
 *
 * Scaling the veil would shrink a full-stage rectangle towards its top-left corner, and scaling the
 * *layer* would do the same to the whole stage, so each part gets its own property list.
 *
 * A part that is already destroyed is skipped (the usual case is a scene shutting down mid-animation):
 * the runner then reports "nothing to animate", which is the caller's signal to tear the layer down at
 * once. A **zero-length** transition is deliberately *not* filtered out here — `TransitionRunner.start()`
 * applies its end state (that is how an explicit `toAlpha`/`toScale` survives reduced motion or an
 * instant policy), and filtering it here is what made that branch unreachable from the modal path (V61).
 */
export function modalTransitionTargets(
  parts: ModalTransitionParts,
  transition: ResolvedTransition,
): TransitionRun[] {
  const runs: TransitionRun[] = [];
  if (parts.scrim && parts.scrim.isDestroyed !== true) {
    runs.push({ target: parts.scrim, transition, props: ['alpha'] });
  }
  if (parts.content.isDestroyed !== true) {
    runs.push({ target: parts.content, transition });
  }
  return runs;
}

/** One animation to start. */
export interface TransitionRun {
  readonly target: TransitionTarget;
  readonly transition: ResolvedTransition;
  /** Properties to animate; defaults to every property the transition mentions. */
  readonly props?: readonly TransitionProp[];
  /** Called once when this run reaches its end (never when it is cancelled or its target dies). */
  readonly onDone?: () => void;
}

interface ActiveRun {
  readonly target: TransitionTarget;
  readonly transition: ResolvedTransition;
  readonly props: readonly TransitionProp[];
  readonly alphaFrom: number;
  readonly alphaTo: number;
  readonly scaleFrom: number;
  readonly scaleTo: number;
  readonly onDone?: () => void;
  /** The group this run belongs to, when it was started by `runGroup`. */
  group?: RunGroup;
  elapsed: number;
}

/** A set of runs whose completion is reported once — see `runGroup`. */
interface RunGroup {
  left: number;
  readonly onDone?: () => void;
}

function isAlive(target: TransitionTarget): boolean {
  return target.isDestroyed !== true;
}

/**
 * Applies transitions frame by frame.
 *
 * The runner owns no timer and no tween: the plugin steps it from its own `PRE_UPDATE` hook, so a
 * transition cannot outlive the scene that started it, and `clear()` (called on teardown) leaves
 * nothing behind for the leak counters to find.
 */
export class TransitionRunner {
  private runs: ActiveRun[] = [];
  /** Targets handed to `runGroup` waiting for their siblings — see `runGroup`. */
  private groups: RunGroup[] = [];

  /** How many targets are animating right now. */
  get pending(): number {
    return this.runs.length;
  }

  /**
   * Starts one animation.
   *
   * @returns `true` when frames will follow; `false` when the transition is instant, in which case the
   * end state has already been applied and `onDone` is **not** called (the caller acts on the return
   * value — that is what keeps an instant close synchronous).
   */
  run(options: TransitionRun): boolean {
    return this.start(options) !== null;
  }

  /** Builds and registers the run, or applies the end state and returns `null` when it is instant. */
  private start(options: TransitionRun): ActiveRun | null {
    const { target, transition } = options;
    if (!isAlive(target)) {
      return null;
    }
    // One run per target, newest wins. A dialog has two animations that can overlap in real use — its
    // entrance and its exit, for a user who dismisses it within the enter duration (measured on
    // `#/modal`: open, then `close()` 5 ms later) — and with both live the two runs write the same
    // `alpha`/`scale` every frame. The older one wins the frame (the loop below walks backwards), so the
    // dialog faded back *in* while it was on its way out, and the exit only showed as a jump to the end
    // state when its own run finished. Taking the target over makes "the last thing asked for" the thing
    // that happens, and it also means a cancelled group can complete a teardown it deferred.
    this.cancel(target);
    const props = options.props ?? defaultProps(transition);
    const alphaFrom = endpointValue(transition.alpha?.[0], target.alpha);
    const alphaTo = endpointValue(transition.alpha?.[1], target.alpha);
    const scaleFrom = endpointValue(transition.scale?.[0], target.scaleX);
    const scaleTo = endpointValue(transition.scale?.[1], target.scaleX);

    if (transition.duration <= 0) {
      applyAt(target, props, alphaFrom, alphaTo, scaleFrom, scaleTo, 1);
      return null;
    }

    // The first frame is applied immediately: waiting for the next `step()` would show one frame of
    // the finished dialog (and for an exit, one frame of it still fully visible).
    applyAt(target, props, alphaFrom, alphaTo, scaleFrom, scaleTo, 0);
    const active: ActiveRun = {
      target,
      transition,
      props,
      alphaFrom,
      alphaTo,
      scaleFrom,
      scaleTo,
      onDone: options.onDone,
      elapsed: 0,
    };
    this.runs.push(active);
    return active;
  }

  /**
   * Starts several animations as one unit.
   *
   * Phaser gives no "wait for these two" outside the tween manager, and a dialog fades as two widgets
   * (scrim and body), so the count lives here: `onDone` fires once, after the last sibling finishes.
   *
   * @returns how many targets are animating; `0` means the group was instant end to end and `onDone`
   * was **not** called.
   */
  runGroup(runs: readonly TransitionRun[], onDone?: () => void): number {
    const group: RunGroup = { left: 0, onDone };
    for (const run of runs) {
      const active = this.start({ ...run, onDone: undefined });
      if (active) {
        active.group = group;
        group.left += 1;
      }
    }
    if (group.left === 0) {
      return 0;
    }
    this.groups.push(group);
    return group.left;
  }

  /** Cancels any animation of `target`, leaving it on the current frame. */
  cancel(target: TransitionTarget): boolean {
    const before = this.runs.length;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const active = this.runs[i];
      if (active && active.target === target) {
        this.runs.splice(i, 1);
        this.detach(active);
      }
    }
    return this.runs.length !== before;
  }

  /**
   * Advances every run by `delta` milliseconds.
   *
   * @returns how many runs finished on this step (the leak gates care that it reaches `0`).
   */
  step(delta: number): number {
    if (this.runs.length === 0) {
      return 0;
    }
    const advance = Number.isFinite(delta) && delta > 0 ? delta : 0;
    let finished = 0;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const active = this.runs[i];
      if (!active) {
        continue;
      }
      if (!isAlive(active.target)) {
        // Whatever destroyed the widget owns the consequences; calling `onDone` here would touch a
        // teardown that has already run (the usual case: the scene shut down mid-animation).
        this.runs.splice(i, 1);
        this.detach(active);
        continue;
      }
      active.elapsed += advance;
      const progress = progressOf(active.transition, active.elapsed);
      applyAt(
        active.target,
        active.props,
        active.alphaFrom,
        active.alphaTo,
        active.scaleFrom,
        active.scaleTo,
        progress,
      );
      if (progress >= 1) {
        this.runs.splice(i, 1);
        finished += 1;
        const done = active.onDone;
        this.detach(active);
        done?.();
      }
    }
    return finished;
  }

  /** Drops every run without calling `onDone` (scene teardown). */
  clear(): void {
    this.runs.length = 0;
    this.groups.length = 0;
  }

  /** Decrements the group a finished/cancelled run belonged to, firing `onDone` on the last one. */
  private detach(active: ActiveRun): void {
    const group = active.group;
    if (!group) {
      return;
    }
    active.group = undefined;
    group.left -= 1;
    if (group.left > 0) {
      return;
    }
    const index = this.groups.indexOf(group);
    if (index !== -1) {
      this.groups.splice(index, 1);
    }
    group.onDone?.();
  }
}

function defaultProps(transition: ResolvedTransition): readonly TransitionProp[] {
  const props: TransitionProp[] = [];
  if (transition.alpha) {
    props.push('alpha');
  }
  if (transition.scale) {
    props.push('scale');
  }
  return props;
}

function endpointValue(endpoint: Endpoint | undefined, base: number): number {
  if (endpoint === undefined || endpoint === 'base') {
    return base;
  }
  return Number.isFinite(endpoint) ? endpoint : base;
}

/** Progress `0`…`1` of a run after `elapsed` ms, delay included. */
export function progressOf(transition: ResolvedTransition, elapsed: number): number {
  if (transition.duration <= 0) {
    return 1;
  }
  const active = elapsed - transition.delay;
  if (active <= 0) {
    return 0;
  }
  const t = clamp01(active / transition.duration);
  return clamp01(easingOf(transition.easing)(t));
}

function applyAt(
  target: TransitionTarget,
  props: readonly TransitionProp[],
  alphaFrom: number,
  alphaTo: number,
  scaleFrom: number,
  scaleTo: number,
  progress: number,
): void {
  for (const prop of props) {
    if (prop === 'alpha') {
      target.setAlpha(lerp(alphaFrom, alphaTo, progress));
    } else {
      const value = lerp(scaleFrom, scaleTo, progress);
      target.setScale(value, value);
    }
  }
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}
