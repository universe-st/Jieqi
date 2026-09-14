/**
 * Scene plugin: `this.mvvm` inside a Scene.
 *
 * Registered through the Game Config:
 *
 * ```ts
 * new Phaser.Game({
 *   plugins: {
 *     scene: [{ key: 'MVVMPlugin', plugin: MVVMPlugin, mapping: 'mvvm', start: true }],
 *   },
 * });
 * ```
 *
 * Responsibilities:
 * - own the `UIRoot` (created lazily through `this.mvvm.root`),
 * - drive the frame-aligned flush: pending reactive updates are flushed once per frame **before**
 *   layout, so N data changes in a frame cost one layout pass (ADR-0008),
 * - route input: pointer via `InputRouter`, keyboard/gamepad navigation via `FocusManager`
 *   (+ `NavRepeat` for held directions),
 * - tear the UI down on scene `shutdown`/`destroy` so widgets, listeners and bindings cannot leak.
 */

import Phaser from 'phaser';
import { devLog, isDevMode, warn } from '@phaser-mvvm/core';
import { flushFrame } from '@phaser-mvvm/core';
import { FocusManager } from './focus';
import { InputRouter } from './input';
import { A11yBridge } from './a11y';
import { ModalHost } from './modal';
import { planBack } from './back-plan';
import { revealInViewports } from './reveal';
import { PageHost } from './pages';
import { detectRenderScale, quantizeTextResolution } from './render-scale';
import { Router } from './router';
import {
  mergePluginConfig,
  pluginConfigFromGameConfig,
  type MVVMPluginConfig,
} from './plugin-config';
import {
  TransitionRunner,
  prefersReducedMotion,
  resolveTransitions,
  type ResolvedTransitions,
  type TransitionOverride,
} from './transition';
import { NavSourceRegistry, type NavAction, type NavSource, type NavSourceHost } from './nav';
import { GamepadNavSource, KeyboardNavSource } from './nav-sources';
import { getTheme, onThemeChange, setTheme, type Theme, type ThemeName } from './theme';
import { UIRoot } from './UIRoot';
import type { UISceneBackHook } from './UIScene';
import { Widget, type ActivationSource } from './Widget';

export class MVVMPlugin extends Phaser.Plugins.ScenePlugin {
  /**
   * Game-wide defaults, applied to every plugin created after {@link MVVMPlugin.configure}.
   *
   * Phaser instantiates scene plugins as `new Plugin(scene, pluginManager, mapKey)`, so the fourth
   * (config) argument of a Game Config entry is never passed. Two supported ways to configure the
   * framework came out of that: **this** static (game-wide, before `new Phaser.Game(...)`) and the
   * entry's own `data` field, which the plugin reads back from `game.config.installScenePlugins`
   * (`pluginConfigFromGameConfig`). Precedence is defaults → Game Config entry → per-instance config →
   * `mvvm.configure()` at runtime; `mvvm.config` reports what a scene ended up with.
   */
  private static shared: MVVMPluginConfig = {};

  /** Merges `config` into the defaults every later plugin instance starts from. */
  static configure(config: MVVMPluginConfig): void {
    MVVMPlugin.shared = mergePluginConfig(MVVMPlugin.shared, config);
  }

  /** The current game-wide defaults (read-only copy). */
  static get defaults(): Readonly<MVVMPluginConfig> {
    return MVVMPlugin.shared;
  }

  /** Forgets the game-wide defaults (tests, and a "reconfigure from scratch" in dev tools). */
  static resetDefaults(): void {
    MVVMPlugin.shared = {};
  }

  private options: MVVMPluginConfig;
  /**
   * Options that arrived through the Game Config entry's `data` field, before defaults and patches.
   *
   * Kept apart so `config` can report where a value came from, and so a diagnostic ("this scene runs
   * with `navigation: false`, and nobody called `configure`") is answerable.
   */
  private entryOptions: MVVMPluginConfig = {};
  private uiRoot: UIRoot | null = null;
  private inputRouter: InputRouter | null = null;
  private focusManager: FocusManager | null = null;
  /**
   * Every device this scene accepts navigation from (round 110).
   *
   * The built-ins (`KeyboardNavSource`, `GamepadNavSource`) are registered in the constructor, so
   * `mvvm.navSources` answers "what can move focus here" and an app can add its own with
   * `registerNavSource()`. Each entry carries its own hold-to-repeat clock — that is what keeps a pad's
   * timing separate from the keyboard's, and the action attributable to the device that produced it.
   */
  private readonly navSourcesRegistry = new NavSourceRegistry();
  /**
   * Extra sources registered by the app, kept across `navigation` toggles and scene restarts.
   *
   * `applyNavigation()` rebuilds what is *attached*; this list is what it rebuilds from.
   */
  private readonly appNavSources: NavSource[] = [];
  private lastStructureVersion = -1;
  /** Last widget reported by the development focus trace. */
  private lastFocused: Widget | null = null;
  /**
   * Key events already acted on in this frame; see `onKeyDown`.
   *
   * A *set* and not "the previous event", because one frame can deliver several keydowns (Shift and
   * then Tab) and Phaser re-emits the whole queue in order, so the event that repeats is not the one
   * that came before it.
   */
  private readonly handledKeyEvents = new Set<KeyboardEvent>();
  private unsubscribeTheme: (() => void) | null = null;
  private modalHost: ModalHost | null = null;
  private pageHost: PageHost | null = null;
  private routeHost: Router | null = null;
  /**
   * Frame-stepped transitions. One runner for the scene: the frame delta it needs is already available
   * here, and a scene-wide runner is what lets `pending` answer "is any teardown still deferred?".
   */
  private readonly transitionRunner = new TransitionRunner();
  /** Last `PRE_UPDATE` timestamp, to turn Phaser's clock into a per-frame delta (ms). */
  private lastFrameTime = -1;
  private a11yBridge: A11yBridge | null = null;
  /** Dev-only: whether the "something replaced the back router" warning was already printed. */
  private warnedBackOverride = false;
  /**
   * The plugin's own back router, kept as a stable reference so the dev guard below can tell whether
   * anything replaced it.
   */
  private readonly backRouter = (): void => this.handleBack();

  constructor(
    scene: Phaser.Scene,
    pluginManager: Phaser.Plugins.PluginManager,
    pluginKey: string,
    config: MVVMPluginConfig = {},
  ) {
    super(scene, pluginManager, pluginKey);
    // Three sources, weakest first: the game-wide defaults `MVVMPlugin.configure()` builds, the
    // options the Game Config entry carries in its `data` field (read back from
    // `game.config.installScenePlugins`, since Phaser never passes them to a scene plugin's
    // constructor), and finally a per-instance config — which Phaser never supplies either, but which
    // tests and a host that builds the plugin by hand can.
    this.entryOptions = pluginConfigFromGameConfig(
      (pluginManager?.game?.config as { installScenePlugins?: unknown } | undefined)
        ?.installScenePlugins,
      pluginKey,
    );
    this.options = mergePluginConfig(
      mergePluginConfig(MVVMPlugin.shared, this.entryOptions),
      config,
    );
  }

  /**
   * The host object every registered `NavSource` talks to.
   *
   * One stable instance for the plugin's whole life (a scene plugin belongs to exactly one scene), so a
   * per-frame poll allocates nothing. `scene` is a live getter rather than a captured value: an app
   * registers sources in `create()`, and Phaser assigns `this.scene` on the plugin before that.
   */
  private readonly navHost: NavSourceHost = (() => {
    const plugin = this;
    return {
      get scene(): Phaser.Scene {
        return plugin.scene as Phaser.Scene;
      },
      now: () => plugin.scene?.time?.now ?? 0,
      handleKeyEvent: (event, action) => plugin.handleKeyEvent(event, action),
      dispatch: (action, source) => plugin.dispatchAction(action, source),
    };
  })();

  /**
   * The options the plugin is actually running with (read-only view).
   *
   * The counterpart of `MVVMPlugin.defaults`: `defaults` answers "what did the app configure
   * game-wide", this answers "so what does *this* scene use". An acceptance page prints it, which is
   * how the Game Config entry channel above is observable at all.
   */
  get config(): Readonly<MVVMPluginConfig> {
    return { ...this.options };
  }

  /**
   * Device pixels one layout unit covers on this display: `devicePixelRatio × (canvas CSS width ÷ game
   * size)`.
   *
   * It is `1` on a plain 1× display, `2` on a Retina one, and — the case that is easy to miss — `1.5`
   * for a `FIT` game whose 450×900 design is scaled down to 338 CSS pixels and then upscaled to 677
   * device pixels. Phaser does not size its drawing buffer by `devicePixelRatio`, so this is *not* the
   * buffer's grid (see `UIRootOptions.dpr`) — it is how large the result is on the glass.
   *
   * Read it when baking your own art into a texture (a chip, a piece, a board), so the bake matches the
   * pixels the display will actually show. The UI's own text already does this automatically.
   */
  get renderScale(): number {
    // The root's own width, not the game size: a page rendering at device resolution lays out in design
    // units while the game is `devicePixelRatio` times bigger, and every consumer of this number (glyph
    // textures, the DOM input bridge, an app baking its own art) works in layout units. Falling back to
    // the game size keeps the unmagnified case unchanged. `uiRoot` rather than `root`, because reading
    // this must not *create* a root as a side effect.
    return detectRenderScale(this.scene as Phaser.Scene | undefined, this.uiRoot?.layoutSize.width);
  }

  /**
   * Resolution the widgets bake their text textures at — `MVVMPluginConfig.textResolution` when set,
   * otherwise {@link renderScale} rounded to a ½ step and capped at 2.
   *
   * Widgets read it when they build their `Phaser.GameObjects.Text`, so it applies to the text they
   * create *after* it changes (a theme switch or a rebuild picks up a new value; a resize that changes
   * the fit zoom only affects text built afterwards).
   */
  get textResolution(): number {
    const override = this.options.textResolution;
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
    return quantizeTextResolution(this.renderScale);
  }

  /**
   * Names of the navigation sources currently registered, in registration order.
   *
   * Includes the built-ins (`keyboard`, `gamepad`) and anything the app added with
   * {@link registerNavSource}.
   */
  get navSources(): readonly string[] {
    return this.navSourcesRegistry.names;
  }

  /**
   * Adds a navigation source to this scene — a second pad, a TV remote, an on-screen D-pad, a test
   * harness. See {@link NavSource} for what a source is.
   *
   * The source is attached immediately unless `navigation: false`, and it survives `configure()` and a
   * scene restart (only its attachment is torn down and rebuilt). Registering the same name twice
   * throws, because `unregisterNavSource(name)` would otherwise be ambiguous.
   *
   * ```ts
   * this.mvvm.registerNavSource({
   *   name: 'touch-dpad',
   *   source: 'touch',
   *   heldDirections: () => this.dpad.directions(),
   * });
   * ```
   */
  registerNavSource(source: NavSource): this {
    // Registering is idempotent per name so that a scene's `create()` can run again after a restart:
    // the previous attachment is gone by then, but the registration is not.
    if (this.navSourcesRegistry.has(source.name)) {
      const index = this.appNavSources.findIndex((entry) => entry.name === source.name);
      if (index === -1) {
        throw new Error(
          `MVVMPlugin.registerNavSource: "${source.name}" is a built-in source and cannot be replaced`,
        );
      }
      this.appNavSources[index] = source;
      this.navSourcesRegistry.remove(source.name);
      this.navSourcesRegistry.add(source, this.navHost);
      return this;
    }
    this.appNavSources.push(source);
    this.navSourcesRegistry.add(source, this.navHost);
    return this;
  }

  /** Detaches and forgets a source registered by the app. Returns whether it was there. */
  unregisterNavSource(name: string): boolean {
    const index = this.appNavSources.findIndex((entry) => entry.name === name);
    if (index === -1) {
      return false;
    }
    this.appNavSources.splice(index, 1);
    return this.navSourcesRegistry.remove(name);
  }

  override boot(): void {
    const events = this.systems?.events;
    if (!events) {
      return;
    }
    // `on`, not `once`, and the subscriptions survive a shutdown. Phaser runs `boot()` exactly once
    // per scene, so a handler consumed by the first SHUTDOWN left a *restarted* scene with no
    // PRE_UPDATE pump (no frame flush, no layout, no input routing) and no teardown on later
    // shutdowns — every restart then leaked a complete UI tree (theme listeners, pointer targets and
    // one text texture per label). Only the plugin's own `destroy()` unsubscribes.
    events.on(Phaser.Scenes.Events.PRE_UPDATE, this.onPreUpdate, this);
    events.on(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    events.on(Phaser.Scenes.Events.DESTROY, this.onShutdown, this);
  }

  /**
   * App-level `back` handler (Escape, gamepad B/○), called when neither a modal nor a page wanted the
   * action.
   *
   * This is the supported place to put it. `FocusManager.onBack` is the *low-level* hook the plugin
   * installs for routing (`modal → page → app`), so assigning it directly takes the modal stack and the
   * page stack out of the loop — the guide used to suggest exactly that, and the failure was silent.
   */
  onBack: (() => void) | null = null;

  /** The UI root of this scene; created on first access (and wired for input). */
  get root(): UIRoot {
    if (!this.uiRoot) {
      const scene = this.scene;
      if (!scene) {
        throw new Error('MVVMPlugin.root: the plugin is not attached to a Scene yet');
      }
      this.uiRoot = new UIRoot(scene, this.options);
      this.attachUi();
    }
    return this.uiRoot;
  }

  /**
   * Applies options **at runtime**, to this scene's plugin.
   *
   * Options that describe how the UI is *built* (align, depth, `input.dragThreshold`, …) can only take
   * effect when the root is created, so they are stored and used then; the ones that describe a
   * *subscription* (`navigation`, `themeBackground`, `a11y`, `focus.wrap`, `focus.trapFocus`,
   * `input.dragThreshold` on a live router) are applied immediately, because a caller that changes them
   * mid-session means it.
   *
   * ```ts
   * MVVMPlugin.configure({ themeBackground: false });   // game-wide, before `new Phaser.Game(...)`
   * this.mvvm.configure({ navigation: false });         // just this scene, right now
   * ```
   */
  configure(patch: MVVMPluginConfig): this {
    this.options = mergePluginConfig(this.options, patch);
    if (!this.uiRoot) {
      return this;
    }

    if (patch.navigation !== undefined) {
      this.applyNavigation();
    }
    if (patch.themeBackground !== undefined) {
      this.applyThemeBackground();
    }
    if (patch.input?.dragThreshold !== undefined && this.inputRouter) {
      this.inputRouter.dragThreshold = patch.input.dragThreshold;
    }
    if (patch.focus && this.focusManager) {
      if (patch.focus.wrap !== undefined) {
        this.focusManager.wrap = patch.focus.wrap;
      }
      if (patch.focus.trapFocus !== undefined) {
        this.focusManager.trapFocus = patch.focus.trapFocus;
      }
      if (patch.focus.ring !== undefined) {
        this.focusManager.ring = patch.focus.ring;
      }
    }
    if (patch.a11y !== undefined) {
      this.applyA11yOptions();
    }
    if (isDevMode()) {
      devLog(`configure: applied ${Object.keys(patch).join(', ')}`);
    }
    return this;
  }

  /** True once a UI root exists (used by tests to avoid creating one accidentally). */
  get hasRoot(): boolean {
    return this.uiRoot !== null;
  }

  /** Pointer routing for the UI tree. */
  get input(): InputRouter {
    void this.root;
    return this.inputRouter as InputRouter;
  }

  /** Keyboard/gamepad focus management for the UI tree. */
  get focus(): FocusManager {
    void this.root;
    return this.focusManager as FocusManager;
  }

  /** Current theme (widgets repaint themselves when it changes). */
  get theme(): Theme {
    return getTheme();
  }

  /**
   * Overlay layers of this scene: `this.mvvm.modal.open(() => { … })`.
   *
   * Created on first use, so a scene that never shows a dialog pays nothing for the feature.
   */
  get modal(): ModalHost {
    if (!this.modalHost) {
      this.modalHost = new ModalHost(this);
    }
    return this.modalHost;
  }

  /**
   * The page stack of this scene: `this.mvvm.pages.push(() => { … })`.
   *
   * Created on first use, like `modal`. Pop it with `pop()`, or let `Escape`/gamepad B do it — the
   * plugin routes `back` to the modals first, then to the pages, then to `config.onBack`.
   */
  get pages(): PageHost {
    if (!this.pageHost) {
      this.pageHost = new PageHost(this);
    }
    return this.pageHost;
  }

  /**
   * The optional router above the page stack (`router.ts`): a table of `path → view`.
   *
   * ```ts
   * this.mvvm.router.routes = { home: () => { … }, 'user/:id': (params) => { … } };
   * this.mvvm.router.navigate('user/42');
   * ```
   *
   * Created on first use, like `modal` and `pages`. It adds no navigation model of its own: navigating
   * is `pages.push()`, so `Esc`, page lifecycle hooks and focus behave exactly as they do without it —
   * the router only remembers which page came from which route (`current`, `history`).
   */
  get router(): Router {
    if (!this.routeHost) {
      this.routeHost = new Router(this);
    }
    return this.routeHost;
  }

  /**
   * The frame-stepped transition runner (PLAN M8's 开闭动效).
   *
   * Exposed for the demo pages, and for a scene that wants to animate a layer of its own with the same
   * timing model: `this.mvvm.transitions.run({ target, transition })`. `pending` is the number of
   * targets still animating — a dialog's exit is the one teardown in the framework that is *deferred*,
   * so "nothing animating any more" is the honest way to know it finished.
   */
  get transitions(): TransitionRunner {
    return this.transitionRunner;
  }

  /**
   * Resolves the motion policy for one layer: the plugin config, an optional per-layer override, and
   * what the OS asks for right now.
   *
   * Resolved per use rather than cached, so `mvvm.configure({ transition: … })` and a
   * `prefers-reduced-motion` change both reach the next dialog; the cost is one `matchMedia` read per
   * open.
   */
  transitionFor(override?: TransitionOverride): ResolvedTransitions {
    const options = this.options.transition;
    // The durations come from the theme (`Theme.motion`), so switching to a theme with a different
    // motion vocabulary retimes every dialog and page transition at once; an explicit duration in the
    // config, in a per-layer option or in a spec still wins (see `resolveTransitions`).
    const resolved = resolveTransitions(
      options,
      override,
      prefersReducedMotion(),
      this.theme.motion,
    );
    if (isDevMode() && resolved.reduced && options !== false && override !== false) {
      devLog('transition: collapsed to 0 ms — the page asks for reduced motion');
    }
    return resolved;
  }

  /**
   * The hidden DOM mirror of the interactive widgets (`a11y.ts`).
   *
   * Created on first use; `this.mvvm.a11y.enabled = false` removes it from the DOM and stops all
   * updates, which is what a game that does not want the extra nodes should do.
   */
  get a11y(): A11yBridge {
    if (!this.a11yBridge) {
      const options = this.options.a11y === false ? { enabled: false } : (this.options.a11y ?? {});
      this.a11yBridge = new A11yBridge(this, options);
    }
    return this.a11yBridge;
  }

  /** Switches the theme used by every widget in every scene. */
  setTheme(theme: ThemeName | Theme): Theme {
    return setTheme(theme);
  }

  /** Adds a widget to the UI root, wires it for input and lays out immediately. */
  mount<T extends Widget>(child: T): T {
    const mounted = this.root.addWidget(child);
    // A page appended to the root would paint over an open dialog; the layers go back on top.
    this.modalHost?.raiseLayers();
    this.refreshInteraction();
    if (isDevMode()) {
      devLog(`mount: page attached and laid out (${countWidgets(child)} widget(s))`);
    }
    return mounted;
  }

  /** Re-collects focusable widgets and pointer targets (call after structural changes). */
  refreshInteraction(): void {
    if (!this.uiRoot) {
      return;
    }
    // `refresh()` (not `attach()`) — attaching detaches first, which would silently drop a capture
    // widget set for a modal overlay.
    this.inputRouter?.refresh();
    this.focusManager?.refresh();
    // The mirror follows the interactive set, so it is rebuilt exactly when that set can change.
    // `this.a11y` (not the field) on purpose: the layer is created on the first structural change, so a
    // scene gets a mirror without anyone having to ask for it — `a11y: false` (config) or
    // `enabled = false` (runtime) is how an app opts out.
    if (this.options.a11y !== false) {
      this.a11y.refresh();
    }
  }

  /** Runs pending reactive updates, then a layout pass. Called automatically each frame. */
  flush(): void {
    flushFrame();
    this.uiRoot?.flushLayout();
  }

  override destroy(): void {
    this.dispose();
    this.detachEvents();
    super.destroy();
  }

  private attachUi(): void {
    const scene = this.scene;
    const root = this.uiRoot;
    if (!scene || !root) {
      return;
    }
    this.lastStructureVersion = root.structureVersion;

    this.inputRouter = new InputRouter({ root, ...this.options.input });
    // Pointer presses move focus (the router only reports them; the manager owns the order). The press
    // is marked as such, so focus moves but the control is *not* lit up (CSS `:focus-visible`):
    // `FocusManager#focus` explains the split, `Widget#focusRingOnPointer` the text-field exception.
    this.inputRouter.onPointerFocus = (widget) => {
      // Note the modality *before* focusing: everything the press triggers from here on — a dialog's
      // `focusFirst`, a page transition's restored focus — is a consequence of this tap and must not
      // paint a ring (`FocusManager#noteInput`).
      this.focusManager?.noteInput('pointer');
      this.focusManager?.focus(widget, { pointer: true });
    };
    this.inputRouter.attach(root, scene);

    this.focusManager = new FocusManager({
      root,
      ...this.options.focus,
      // `back` is routed, never handled here: `handleBack()` asks the modal stack, then the page stack,
      // then the app (see `back-plan.ts`).
      onBack: this.backRouter,
    });

    this.applyThemeBackground();
    this.applyNavigation();
    this.applyA11yOptions();
  }

  /** Subscribes (or not) to theme changes for the camera background; idempotent. */
  private applyThemeBackground(): void {
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    if (this.options.themeBackground === false) {
      // The app owns the camera colour now: stop following the theme, leave what is there.
      return;
    }
    this.applyThemeToCamera(getTheme());
    this.unsubscribeTheme = onThemeChange((theme) => this.applyThemeToCamera(theme));
  }

  /**
   * Registers the built-in sources and attaches everything the scene accepts navigation from.
   *
   * Idempotent, so `configure({ navigation })`, `boot()` and a scene restart can all call it: whatever
   * is attached is detached first, then re-attached from the registrations. `navigation: false` means
   * **no source at all** — including the ones an app registered, because "navigation is off" is a
   * statement about the scene, not about one device.
   */
  private applyNavigation(): void {
    if (this.navSourcesRegistry.size === 0) {
      this.navSourcesRegistry.add(new KeyboardNavSource(), this.navHost);
      this.navSourcesRegistry.add(new GamepadNavSource(), this.navHost);
      // App-registered sources are re-added from the app's own list so that a `configure()` toggle
      // cannot forget them; the registry is the *attached* set, `appNavSources` the declaration.
      for (const source of this.appNavSources) {
        if (!this.navSourcesRegistry.has(source.name)) {
          this.navSourcesRegistry.add(source, this.navHost);
        }
      }
    }
    this.navSourcesRegistry.detachAll();
    if (this.options.navigation === false) {
      return;
    }
    this.navSourcesRegistry.attachAll(this.navHost);
  }

  /** Creates, enables or reconfigures the accessibility mirror; idempotent. */
  private applyA11yOptions(): void {
    const options = this.options.a11y;
    if (!this.a11yBridge) {
      if (options === false || options === undefined) {
        return;
      }
      this.a11yBridge = new A11yBridge(this, options);
      return;
    }
    if (options === false) {
      this.a11yBridge.enabled = false;
      return;
    }
    const next = options ?? {};
    this.a11yBridge.enabled = next.enabled !== false;
    if (next.politeness !== undefined) {
      this.a11yBridge.politeness = next.politeness;
    }
  }

  /** Keeps the canvas clear colour in step with the theme so a switch repaints the whole page. */
  private applyThemeToCamera(theme: Theme): void {
    this.scene?.cameras?.main?.setBackgroundColor(theme.colors.background);
  }

  /**
   * `back` action routing (Escape / gamepad B).
   *
   * The order lives in `planBack()` (a pure function with Node tests): a modal owns the action first,
   * then the page stack. After that the *scene* gets first refusal (`UIScene.onBack`, when the scene
   * opted in with its `backHook` marker), and only an app with nowhere left to go sees its own
   * `onBack` — so a scene can intercept Escape without taking the app-level handler away.
   */
  private handleBack(): void {
    const target = planBack({
      modalDepth: this.modalHost?.depth ?? 0,
      pageDepth: this.pageHost?.depth ?? 0,
    });

    if (target === 'modal') {
      // `handleBack()` also covers the non-dismissible dialog, which swallows the action on purpose.
      this.modalHost?.handleBack();
      return;
    }
    if (target === 'page' && this.pageHost?.handleBack() === true) {
      return;
    }
    const scene = this.scene as (Phaser.Scene & UISceneBackHook) | null;
    if (scene?.backHook === true && scene.onBack?.() === true) {
      return;
    }
    // `config.onBack` can never arrive (Phaser instantiates scene plugins with three arguments), so
    // `mvvm.onBack` is the usable field; `config.focus.onBack` stays supported as the legacy spelling.
    (this.onBack ?? this.options.onBack ?? this.options.focus?.onBack)?.();
  }

  /**
   * A raw key event handed over by a keyboard source (`KeyboardNavSource`).
   *
   * The device-specific part (which event means which action) already happened in the source; what is
   * left here is everything about the *scene*: de-duplication, the browser-shortcut guard, the focused
   * widget's first refusal and `preventDefault()`.
   */
  private handleKeyEvent(event: KeyboardEvent, action: NavAction | null): boolean {
    // Phaser reaches this listener through `KeyboardPlugin.update()`, which walks the manager's whole
    // input queue on *every* input event of the frame and only skips **consecutive** duplicates
    // (`prevCode`/`prevTime`/`prevType`). Two keydowns in one frame therefore deliver the first one
    // twice - and `Shift+Tab` is two keydowns (Shift, then Tab), so one press navigated two steps
    // (measured: `prev` arrived twice, `form.ok -> form.cancel -> form.field`). Key repeat and fast
    // typing do the same thing. Re-emission hands us the *same* event object, so identity is an exact
    // test; a fresh press always carries a new one.
    if (this.handledKeyEvents.has(event)) {
      return false;
    }
    this.handledKeyEvents.add(event);

    // Never swallow browser shortcuts (copy/paste/reload/devtools).
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }
    // The focused widget gets first refusal, in two steps: `onKeyDown` for the keys it owns beyond
    // navigation (typing, Home/End, PageUp/PageDown), then `onAction` for the navigation actions
    // themselves — so a direction claimed once works on a gamepad too (`Widget#onAction`).
    const focused = this.focusManager?.focusedWidget ?? null;
    if (focused && focused.onKeyDown?.(event, action) === true) {
      event.preventDefault();
      return true;
    }
    if (!action) {
      return false;
    }
    if (this.dispatchAction(action, 'keyboard')) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  /**
   * Gives the focused widget first refusal on a navigation action, then navigates.
   *
   * Every device goes through here: the keyboard path, the gamepad poll and any source an app
   * registered, so "the D-Pad adjusts the slider" and "the arrow key adjusts the slider" cannot drift
   * apart (V28) — and neither can a third device.
   */
  private dispatchAction(action: NavAction, source: ActivationSource): boolean {
    // The other input funnel: whatever this action focuses next — and anything it opens — belongs to the
    // device that produced it, so a gamepad-driven `Enter` keeps painting the ring (V83).
    this.focusManager?.noteInput(source);
    const focused = this.focusManager?.focusedWidget ?? null;
    if (focused?.onAction?.(action, source) === true) {
      return true;
    }
    return this.focusManager?.handleAction(action, source) ?? false;
  }

  /**
   * One frame of navigation: every source is polled, and the actions it produced are dispatched.
   *
   * Sources report the directions they *hold*; the repeat timing (350 ms, then every 90 ms) belongs to
   * the per-source `NavRepeat` in the registry, so it is one policy for every device rather than one
   * implementation per device.
   */
  private pollNavSources(time: number): void {
    if (this.navSourcesRegistry.size === 0) {
      return;
    }
    for (const { action, source } of this.navSourcesRegistry.poll(this.navHost, time)) {
      this.dispatchAction(action, source);
    }
  }

  private onPreUpdate(time: number): void {
    // One frame's worth of key events is plenty: Phaser clears its own queue in `postUpdate`, so a
    // re-emission cannot outlive the frame, and a fresh press always brings a fresh event object.
    this.handledKeyEvents.clear();
    flushFrame();
    this.uiRoot?.flushLayout();

    // Transitions advance on Phaser's clock, not the wall clock: a paused scene freezes them instead
    // of letting them jump to the end on resume. The per-frame delta is capped at 250 ms so a long
    // stall (a tab switch, a breakpoint) moves the animation forward by one visible step rather than
    // by the whole stall — and the cap only ever applies to a frame nothing was rendered in.
    if (this.transitionRunner.pending > 0) {
      const delta = this.lastFrameTime < 0 ? 0 : Math.min(time - this.lastFrameTime, 250);
      this.transitionRunner.step(delta);
    }
    this.lastFrameTime = time;

    // Development trace for focus: knowing *what* holds focus explains most "my key press went nowhere"
    // reports. One comparison per frame, and nothing at all once `setDevMode(false)` ran (the log call
    // itself is gated, and the comparison is cheap).
    const focused = this.focusManager?.focusedWidget ?? null;
    if (focused !== this.lastFocused) {
      this.lastFocused = focused;
      devLog(`focus: ${focused ? focused.name || focused.constructor.name : 'none'}`);
      // A screen reader follows DOM focus, and a canvas has none of its own: the mirror moves focus to
      // the node (or the field's own `<input>`) that describes the focused control, and falls back to
      // announcing through the live region when it cannot.
      if (this.a11yBridge && !this.a11yBridge.focusChanged(focused)) {
        this.a11yBridge.announceFocus(focused);
      }
      if (focused) {
        // Keyboard/gamepad focus can land on a widget the mask has clipped away, and then the ring is
        // painted where nobody can see it (round 67). Asking the ports above it to scroll it into view
        // is the browser's answer, and this is the place it can run: the layout pass above has just
        // arranged every rect, so the ports compute against real geometry rather than last frame's.
        revealInViewports(focused, { flushLayout: () => this.uiRoot?.flushLayout() });
      }
    }

    // The focused control's own state can change without a focus move (a slider dragged with the arrow
    // keys, a toggle flipped, a validation error appearing), and a screen reader sitting on that node
    // must not read yesterday's value. `sync()` writes only what changed, so this is a comparison in the
    // common case.
    if (this.a11yBridge && focused) {
      this.a11yBridge.sync(focused);
    }

    // Re-collect only when the tree actually changed: visibility or state changes do not need it, and
    // the layout dirty flag cannot be used for this because `UIRoot.addWidget()` lays out eagerly.
    const root = this.uiRoot;
    if (root && root.structureVersion !== this.lastStructureVersion) {
      this.lastStructureVersion = root.structureVersion;
      this.refreshInteraction();
    }

    this.guardBackRouter();

    this.pollNavSources(time);
    this.inputRouter?.update(time);
  }

  /**
   * Development guard for the `back` hook.
   *
   * `FocusManager.onBack` is where the plugin installs its router, and the guide used to tell readers to
   * overwrite it (`this.mvvm.focus.onBack = …`). Doing that silently disables modal-close and page-pop
   * on Escape — the key simply stops working, with nothing in the console. One identity comparison per
   * frame in development (zero in release) turns that into a named warning.
   */
  private guardBackRouter(): void {
    const manager = this.focusManager;
    if (!isDevMode() || !manager) {
      return;
    }
    if (manager.onBack === this.backRouter) {
      this.warnedBackOverride = false;
      return;
    }
    if (this.warnedBackOverride) {
      return;
    }
    this.warnedBackOverride = true;
    warn(
      'focus.onBack was replaced: the plugin routes `back` through this hook (modal stack, then page ' +
        'stack, then the app), so Escape/B no longer closes dialogs or pops pages. Use ' +
        '`this.mvvm.onBack = …` for an app-level handler.',
    );
  }

  /** Tears the UI down; the scene-event subscriptions stay so a restart works (see `boot()`). */
  private onShutdown(): void {
    this.dispose();
  }

  /** Unsubscribes from the scene's events; only the plugin's own teardown does this. */
  private detachEvents(): void {
    const events = this.systems?.events;
    if (!events) {
      return;
    }
    events.off(Phaser.Scenes.Events.PRE_UPDATE, this.onPreUpdate, this);
    events.off(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    events.off(Phaser.Scenes.Events.DESTROY, this.onShutdown, this);
  }

  private dispose(): void {
    // Every source is detached rather than the keyboard listener alone: a source an app registered
    // holds whatever it attached (a listener, a timer, a device subscription), and the registry is the
    // only place that knows how to take it back out — which is what keeps "register a source in
    // `create()`" from leaking one listener per scene restart.
    this.navSourcesRegistry.detachAll();
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    // Transition runs hold widget references and deferred teardowns; the root is about to destroy
    // those widgets anyway, so the runs go without calling their `onDone`.
    this.transitionRunner.clear();
    this.lastFrameTime = -1;
    this.inputRouter?.detach();
    this.inputRouter = null;
    // Before the UI root goes away: the mirror holds references to widgets.
    this.a11yBridge?.destroy();
    this.a11yBridge = null;
    // Before the focus manager, so the app's `onClose`/`onDispose` callbacks run while the scopes
    // still exist. Overlays first (they sit above the pages), then the pages themselves.
    this.modalHost?.dispose();
    this.modalHost = null;
    this.pageHost?.dispose();
    this.pageHost = null;
    this.routeHost?.dispose();
    this.routeHost = null;
    this.focusManager?.dispose();
    this.focusManager = null;
    this.handledKeyEvents.clear();
    if (this.uiRoot) {
      devLog('shutdown: UI tree destroyed (widgets, bindings and listeners released)');
      this.uiRoot.destroy(true);
      this.uiRoot = null;
    }
  }
}

/** Widget count of a subtree, for the development mount trace only. */
function countWidgets(root: Widget): number {
  let total = 1;
  for (const child of root.getWidgetChildren()) {
    total += countWidgets(child);
  }
  return total;
}
