/**
 * `InputRouter` — pointer routing for a widget tree.
 *
 * Phaser already does the hard part (hit testing, cameras, `topOnly`); this router adds the widget
 * semantics on top of it:
 *
 * - hover is *derived* every frame from the router's own hit test instead of being mirrored from
 *   Phaser's `pointerover`/`pointerout` stream. Those events are delivered per interactive object,
 *   so moving the pointer from a button onto the panel behind it produced an `out` on the button
 *   whose "new target" was the panel — and a router that only clears hover when the event *is* the
 *   deepest target left the button highlighted forever. "The deepest widget under the pointer" is a
 *   *state*, not a transition, so recomputing it can never go stale: it also covers a widget that
 *   moved, was hidden or was rebuilt under a stationary pointer, and a pointer that left the canvas,
 * - a press becomes an activation only when the pointer barely moved between down and up
 *   (`dragThreshold`), which is what keeps a `ScrollView` drag from clicking a button,
 * - a disabled widget never hovers, presses or activates, and a widget that is disabled *while*
 *   hovering/pressed is corrected by a per-frame poll,
 * - a *capture* widget (a modal overlay) shields the widgets underneath it.
 *
 * The judgement calls (`isClickGesture`, `diffInteractionState`, `isWithinTree`) are exported as
 * pure functions and tested with plain objects; the class itself only talks to Phaser.
 */

import type Phaser from 'phaser';
import type { ActivationSource, Widget } from './Widget';
import { pointerDragOwner } from './pointer-claim';
import {
  PointerChainHub,
  type ChainPoint,
  type PointerChainNode,
  type PointerChainTrace,
  type PointerKind,
  type PointerPhase,
} from './pointer-chain';

/**
 * Phaser input event names.
 *
 * They are spelled out (rather than read from `Phaser.Input.Events`) so that this module has no
 * *runtime* dependency on Phaser: importing it in a Node test costs nothing. Only the events that
 * describe a *transition* the router cannot observe by polling are hooked (`down`/`up`); hover is
 * polled, so `pointerover`/`pointerout` are deliberately not listened to.
 */
const EVENT_DOWN = 'pointerdown';
const EVENT_UP = 'pointerup';
const EVENT_DESTROY = 'destroy';

/** Default maximum travel (in stage pixels) for a press to count as a click. */
export const DEFAULT_DRAG_THRESHOLD = 8;

export interface InputRouterOptions {
  /** Root widget whose subtree is routed; may also be given later via `attach()`. */
  root?: Widget | null;
  /** Called after a pointer activation was accepted by the widget. */
  onActivate?: (widget: Widget, source: ActivationSource) => void;
  /**
   * Called when a pointer press lands on a focusable widget.
   *
   * Routing and focus are separate concerns (the router owns hit testing, the focus manager owns the
   * tab/arrow order), so the host wires them together: `MVVMPlugin` forwards this to
   * `focusManager.focus()`. Without it a mouse user could never focus a button, and the next `Tab`
   * would jump back to the first focusable instead of continuing from what was just clicked.
   */
  onPointerFocus?: (widget: Widget) => void;
  /** Maximum pointer travel between down and up that still counts as a click. Defaults to 8. */
  dragThreshold?: number;
  /**
   * Called with the record of every pointer chain dispatch (`pointer-chain.ts`).
   *
   * The chain is the Android-style half of routing: the hit test picks the widget, and the chain
   * decides who along the path gets the event first, who may take it away from a descendant, and who
   * consumed it. This hook is how a probe, a dev overlay or a test sees those decisions — the demo
   * scene `#/events` renders it as a live log, and `PointerChainHub`'s unit tests assert the same
   * records without a browser.
   */
  onPointerChain?: (trace: PointerChainTrace) => void;
}

/**
 * The widget a point lands on: **the deepest hit wins**, later siblings beat earlier ones (last child
 * is drawn on top), a hidden subtree is skipped entirely, and a non-target node still lets its
 * children be found.
 *
 * This is `InputRouter.resolveTarget`'s decision, extracted so it can be tested in Node: three of the
 * project's input defects (V1 spaces, V8 per-widget spaces, V9 event ownership) lived in exactly this
 * walk, and it had no unit test at all. The two Phaser-specific halves are parameters:
 *
 * - `pointFor(node)` - the pointer in **that node's** coordinate space. It is per node and not per
 *   tree on purpose: Phaser's own hit test uses the *hit object's* scroll factor, and the router has to
 *   agree with it (ADR-0009).
 * - `isTarget(node)` - whether the node itself can receive input (registered and enabled).
 *
 * Containers are tested *after* their children, which is the "deepest first" order. Two rules cut a
 * whole subtree out of the walk:
 *
 * - a node whose `visible` is `false` (neither it nor its subtree can be hit, matching the layout rule
 *   that a hidden widget leaves the flow),
 * - a node whose `clipsPointer` is `true` (a `ScrollView`) **when the point is outside that node's own
 *   box**: the mask hides the content there, so it must not be clickable either. Without this the
 *   content of a scrolled port stayed live at its logical position - a row scrolled out of view
 *   hovered and clicked through the page *below the port* (V23, measured on `#/pages`).
 */
export function resolveTargetInTree<N extends TargetNode>(
  root: N,
  pointFor: (node: N) => PointLike,
  isTarget: (node: N) => boolean,
): N | null {
  const visit = (node: N, offsetX: number, offsetY: number): N | null => {
    // `routingEnabled: false` is "painted but not a target" (a page fading out under the page above
    // it, an overlay that must not intercept yet): the subtree keeps its pixels and loses its routing.
    if (node.routingEnabled === false) {
      return null;
    }
    // `offset` already includes this node's own position, so the point is expressed relative to the
    // node's origin: the box to test is (0,0)-(width,height), *not* its parent-local rect.
    const rect = node.appliedRect;
    const point = pointFor(node);
    const localX = point.x - offsetX;
    const localY = point.y - offsetY;
    const inside = localX >= 0 && localX <= rect.width && localY >= 0 && localY <= rect.height;

    // A clipping container hides its content outside its own box, so that content cannot be hit
    // either. Tested *before* descending, which is the whole point: the content below the port must
    // not win over whatever the user actually sees there (V23).
    if (!inside && node.clipsPointer === true) {
      return null;
    }

    const children = node.getWidgetChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (!child || child.visible === false || child.routingEnabled === false) {
        continue;
      }
      const found = visit(child as N, offsetX + child.x, offsetY + child.y);
      if (found) {
        return found;
      }
    }

    if (!isTarget(node)) {
      return null;
    }

    return inside ? node : null;
  };

  // `offset` is "the pointer-space position of the node's origin, its own position included", so the
  // root contributes `+root.x/+root.y`. Negating it displaced every hit test by 2*root.(x,y) -
  // invisible only because the layout engine always arranges the UI root at (0,0).
  return visit(root, root.x, root.y);
}

/** The structural shape {@link resolveTargetInTree} walks. */
export interface TargetNode {
  /** Local position inside its parent (a `Widget` is a Phaser container, so this is its origin). */
  x: number;
  y: number;
  /** `false` removes the node *and* its subtree from hit testing. */
  visible?: boolean;
  /**
   * `false` removes the node *and its subtree* from hit testing while it is still painted and laid out
   * (`Widget#routingEnabled`) — the difference between "hidden" and "on screen but not a target".
   */
  routingEnabled?: boolean;
  /**
   * `true` for a node that clips its content to its own box (a `ScrollView`): a point outside that box
   * cannot hit the node *or anything below it*.
   */
  clipsPointer?: boolean;
  /** Rect assigned by the layout engine, in the parent's local coordinates. */
  appliedRect: { width: number; height: number };
  getWidgetChildren(): readonly TargetNode[];
}

/**
 * The pointer expressed in the coordinate space one widget is laid out in.
 *
 * This mirrors `Phaser.Input.InputManager#hitTest` line for line, so the router's own walk and Phaser's
 * hit test can never disagree about *where* the pointer is - the invariant ADR-0009 is built on:
 *
 * ```js
 * px = pointer.worldX + camera.scrollX * gameObject.scrollFactorX - camera.scrollX;
 * ```
 *
 * A scroll factor of `1` gives the world point (the default, unpinned UI); `0` gives the screen point
 * (a camera-pinned HUD). Anything in between interpolates, exactly as the renderer draws it.
 */
export function pointerInWidgetSpace(
  pointer: UiPointer,
  widget: ScrollFactorLike,
  fallbackCamera: CameraLike | null,
): PointLike {
  const camera = pointer.camera ?? fallbackCamera;
  const scrollX = camera?.scrollX ?? 0;
  const scrollY = camera?.scrollY ?? 0;
  return {
    x: pointer.worldX + scrollX * widget.scrollFactorX - scrollX,
    y: pointer.worldY + scrollY * widget.scrollFactorY - scrollY,
  };
}

/** The pointer fields {@link pointerInWidgetSpace} reads. */
export interface UiPointer {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  camera?: CameraLike | null;
}

/** The camera fields {@link pointerInWidgetSpace} reads. */
export interface CameraLike {
  scrollX: number;
  scrollY: number;
}

/** The widget fields {@link pointerInWidgetSpace} reads. */
export interface ScrollFactorLike {
  scrollFactorX: number;
  scrollFactorY: number;
}

/** A plain 2D point. */
export interface PointLike {
  x: number;
  y: number;
}

/**
 * True when a press that started at `down` and ended at `up` was a click rather than a drag.
 *
 * The comparison is strict (`< threshold`), so a pointer that travelled exactly `threshold` pixels
 * is already a drag: `dragThreshold` reads as "clicks need less movement than this".
 */
export function isClickGesture(down: PointLike, up: PointLike, threshold: number): boolean {
  const dx = up.x - down.x;
  const dy = up.y - down.y;
  return Math.sqrt(dx * dx + dy * dy) < threshold;
}

/**
 * Widgets whose interaction state must be reset because they just became disabled.
 *
 * Only the "enabled → disabled" transition is reported: a widget that becomes enabled again has no
 * stale hover/press state to clear, and a widget that was never tracked (no entry in `previous`) is
 * fresh by definition. The function does not mutate `previous` — the caller (the router) refreshes
 * the map once it has reset the widgets it got back.
 */
export function diffInteractionState(
  previous: Map<Widget, boolean>,
  widgets: readonly Widget[],
): Widget[] {
  const stale: Widget[] = [];
  for (const widget of widgets) {
    if (previous.get(widget) === true && widget.enabled === false) {
      stale.push(widget);
    }
  }
  return stale;
}

/** Minimal shape of a node in a `parentContainer` chain. */
export interface ContainerLike {
  readonly parentContainer?: ContainerLike | null;
}

/** The pointer fields hover depends on; a `Phaser.Input.Pointer` satisfies it structurally. */
export interface HoverPointerState {
  /** `false` while the pointer has not been used yet. */
  active?: boolean;
  /** `true` once the pointer drove a touch (including the mouse events a browser fakes from a tap). */
  wasTouch?: boolean;
  /** Timestamp of the most recent movement; still `0` until the pointer has actually moved. */
  moveTime?: number;
}

/**
 * Whether a pointer press on `widget` should also give it framework focus.
 *
 * A disabled widget never takes focus (it is skipped by traversal too), and a widget that is not
 * focusable stays out of the focus set entirely. Extracted as a plain function for the same reason the
 * other router decisions are: `InputRouter` needs a live scene, this rule does not.
 */
export function shouldFocusOnPress(widget: { focusable?: boolean; enabled?: boolean }): boolean {
  return widget.focusable === true && widget.enabled !== false;
}

/**
 * Whether a pointer may drive hover.
 *
 * A *touch* must not: it leaves the pointer where the finger lifted, so a polled hover would pin the
 * highlight onto whatever sits under that spot. `moveTime > 0` keeps a freshly loaded page from
 * highlighting whatever happens to be at the pointer's default (0, 0).
 */
export function isHoverPointer(pointer: HoverPointerState | null | undefined): boolean {
  if (!pointer) {
    return false;
  }
  if (pointer.active === false || pointer.wasTouch === true) {
    return false;
  }
  return (pointer.moveTime ?? 0) > 0;
}

/**
 * Whether the press that just ended leaves a hover behind.
 *
 * A *mouse* press does: the cursor is still on the widget, and restoring hover immediately is what
 * keeps a click from flickering (`syncPointerState` would otherwise re-derive it one frame later).
 * A *touch* press does not: there is no cursor, the finger is gone, and the widget is drawn with the
 * hover look only until the next poll clears it — measured on a real touch sequence as a one-frame
 * flash of `hover` on top of the `focused` state the tap should leave behind.
 */
export function keepsHoverAfterPress(pointer: { wasTouch?: boolean } | null | undefined): boolean {
  return pointer?.wasTouch !== true;
}

/**
 * Whether a widget can *do* anything with the pointer states (`hover`/`pressed`).
 *
 * A hit area alone does not make a control: `Panel` keeps one by default for a different reason —
 * `blockPointer` is the interception layer that stops a press from reaching the game behind the UI —
 * and such a layer is decoration. Painting pointer states on it made every container *flash* as the
 * pointer crossed its children: the router points at the deepest target, so a panel lost `hover` the
 * moment the cursor entered one of its buttons and regained it in the gap between two of them (the
 * showcase's nav column, round 106). The rule is therefore "hover and press belong to controls":
 * focusable, activatable, or explicitly flagged `interactive`.
 */
export function takesPointerStates(widget: {
  focusable?: boolean;
  onActivate?: unknown;
  interactive?: unknown;
}): boolean {
  return (
    widget.focusable === true ||
    (widget.onActivate !== null && widget.onActivate !== undefined) ||
    widget.interactive === true
  );
}

/**
 * True when `node` is `ancestor` itself or one of its descendants in the container chain.
 *
 * This is the containment test behind input capture: events that reach a widget outside the capture
 * subtree must be swallowed, while events inside it (a modal's own buttons) must pass.
 */
export function isWithinTree(node: ContainerLike, ancestor: ContainerLike): boolean {
  let current: ContainerLike | null | undefined = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parentContainer;
  }
  return false;
}

// ---------------------------------------------------------------------------- InputRouter

/** One widget's listeners, kept together so `detach()` can unhook exactly what `attach()` hooked. */
interface WidgetBinding {
  readonly widget: Widget;
  readonly onDown: (pointer: Phaser.Input.Pointer) => void;
  readonly onUp: (pointer: Phaser.Input.Pointer) => void;
  readonly onDestroy: () => void;
}

/** A press that is still held, with the pointer that made it (used to detect a stale press). */
interface HeldPress {
  readonly x: number;
  readonly y: number;
  readonly pointer: Phaser.Input.Pointer;
}

/** A gesture in flight, flattened to names for probes. */
export interface PointerChainSnapshot {
  readonly pointerId: number;
  readonly kind: PointerKind;
  /** The widget that owns the gesture right now. */
  readonly owner: string;
  /** The widget the press landed on. */
  readonly hitTarget: string;
  /** Root → hit target, by widget name. */
  readonly path: readonly string[];
}

/**
 * `Widget.enablePointerInput()` is `protected` (only subclasses may call it), but enabling hit
 * testing *is* the router's job. The narrow cast below is the smallest way to reach it without
 * changing `Widget`.
 */
interface PointerEnableable {
  enablePointerInput(): unknown;
}

function enablePointerInput(widget: Widget): void {
  (widget as unknown as PointerEnableable).enablePointerInput();
}

/** A widget carrying the optional explicit "route my pointer input" marker. */
interface InteractiveFlagged {
  interactive?: unknown;
}

function hasInteractiveFlag(widget: Widget): boolean {
  return (widget as unknown as InteractiveFlagged).interactive === true;
}

/** Panels default to `blockPointer: true`; the flag lives on the widget library, hence the cast. */
function hasBlockPointerFlag(widget: Widget): boolean {
  return (widget as unknown as { blockPointer?: boolean }).blockPointer === true;
}

/** Reads a widget's scene defensively (a destroyed Game Object has its `scene` cleared). */
function liveSceneOf(widget: Widget): Phaser.Scene | null {
  const scene = (widget as { scene?: Phaser.Scene | null }).scene;
  return scene ?? null;
}

/** Routes pointer input for the widgets below a root, plus the per-frame disabled-state fix-up. */
export class InputRouter {
  /** Activation callback, writable so hosts can swap it after construction. */
  onActivate: ((widget: Widget, source: ActivationSource) => void) | null;
  /** Pointer-press focus hook; see `InputRouterOptions.onPointerFocus`. */
  onPointerFocus: ((widget: Widget) => void) | null;
  /** Maximum travel that still counts as a click; see `isClickGesture`. */
  dragThreshold: number;
  /** Chain trace hook; see `InputRouterOptions.onPointerChain`. */
  onPointerChain: ((trace: PointerChainTrace) => void) | null;

  private rootWidget: Widget | null = null;
  private scene: Phaser.Scene | null = null;
  private bindings: WidgetBinding[] = [];
  private widgetCache: Widget[] | null = null;
  private readonly enabledState = new Map<Widget, boolean>();
  private readonly pressedAt = new Map<Widget, HeldPress>();

  /**
   * The Android-style event chain: dispatch, interception (with the disallow veto) and consumption.
   *
   * It runs *in front of* the press/activation logic below, which is what makes it additive: a tree
   * whose widgets never consume a pointer event behaves exactly as it did before, and a widget that
   * does consume one takes the gesture over from the click machinery.
   */
  private readonly hub = new PointerChainHub();
  /**
   * Pointer ids whose current gesture was consumed by the chain.
   *
   * A consumed gesture does not also fire a click: the widget (or an ancestor that intercepted) said
   * it is handling this gesture itself. Focus and the pressed look still happen — the control *is*
   * being pressed — but `activate()` is not what the press means any more.
   */
  private readonly chainOwns = new Map<number, Widget>();
  /** The most recent trace, kept for probes and for `lastChain()`. */
  private lastTrace: PointerChainTrace | null = null;
  /** Pointer id of the dispatch in flight; the chain's disallow question is about that gesture. */
  private dispatchingPointerId = -1;
  /** Offset of each node of the path currently being dispatched, from the routed root's origin. */
  private readonly chainOffsets = new Map<Widget, ChainPoint>();
  /** The pointer in the routed root's own space; the base of every per-node conversion. */
  private readonly chainBase: ChainPoint = { x: 0, y: 0 };
  /** Reused output of the chain's `pointFor`; the chain copies `x`/`y` immediately. */
  private readonly chainPoint: ChainPoint = { x: 0, y: 0 };
  /** Last pointer position delivered to each chain, so an idle frame delivers nothing. */
  private readonly chainLastAt = new Map<number, ChainPoint>();
  private readonly pointForChainNode = (node: PointerChainNode): ChainPoint => {
    const offset = this.chainOffsets.get(node as Widget);
    this.chainPoint.x = this.chainBase.x - (offset?.x ?? 0);
    this.chainPoint.y = this.chainBase.y - (offset?.y ?? 0);
    return this.chainPoint;
  };
  private readonly interceptDisallowed = (node: PointerChainNode): boolean =>
    this.isInterceptDisallowed(node as Widget);

  /** Reused output of `pointerInUiSpace`; nothing holds on to the result past the call. */
  private readonly space = { x: 0, y: 0 };
  private hoveredWidget: Widget | null = null;
  private captureWidget: Widget | null = null;
  private previousTopOnly = true;

  // Scratch arrays, reused so that the per-frame path allocates nothing.
  private readonly hitInput: Phaser.GameObjects.GameObject[] = [];
  private readonly hitOutput: Phaser.GameObjects.GameObject[] = [];

  constructor(options: InputRouterOptions = {}) {
    this.onActivate = options.onActivate ?? null;
    this.onPointerFocus = options.onPointerFocus ?? null;
    this.dragThreshold = options.dragThreshold ?? DEFAULT_DRAG_THRESHOLD;
    this.onPointerChain = options.onPointerChain ?? null;
    if (options.root) {
      this.rootWidget = options.root;
    }
  }

  /** Root of the routed subtree, or `null` while detached. */
  get root(): Widget | null {
    return this.rootWidget;
  }

  /** Scene the router is bound to, or `null` while detached. */
  get boundScene(): Phaser.Scene | null {
    return this.scene;
  }

  /** Widgets currently routed, in tree order. */
  get widgets(): readonly Widget[] {
    return this.widgetList();
  }

  /** The capture widget, if any. */
  get capture(): Widget | null {
    return this.captureWidget;
  }

  /** The pointer chain hub, for hosts that want to drive or inspect gestures. */
  get chainHub(): PointerChainHub {
    return this.hub;
  }

  /** The record of the most recent chain dispatch, or `null` before the first press. */
  get lastChain(): PointerChainTrace | null {
    return this.lastTrace;
  }

  /** Every gesture in flight, as names — the shape a probe or a test can assert on. */
  chains(): PointerChainSnapshot[] {
    return this.hub.activeChains().map((chain) => ({
      pointerId: chain.pointerId,
      kind: chain.kind,
      owner: chain.owner.chainLabel ?? 'anonymous',
      hitTarget: chain.hitTarget.chainLabel ?? 'anonymous',
      path: chain.path.map((node) => node.chainLabel ?? 'anonymous'),
    }));
  }

  /**
   * Ends a gesture from outside the tree: the owner is told (`cancel`) and the chain is dropped.
   *
   * The router calls this itself when a widget on the path is unmounted, hidden from routing or
   * destroyed; it is public because a host can have its own reason to take a gesture away (a scene
   * switch, an incoming call, a re-layout that changes what the gesture means).
   */
  cancelPointer(pointerId: number, reason = 'cancelled'): void {
    if (!this.hub.active(pointerId)) {
      return;
    }
    const chain = this.hub.active(pointerId);
    const path = (chain?.path ?? []) as readonly Widget[];
    this.prepareChainSpace(null, path, chain ? { x: chain.startX, y: chain.startY } : null);
    this.publishTrace(
      this.hub.cancel(
        pointerId,
        {
          kind: chain?.kind ?? 'mouse',
          stageX: this.chainBase.x,
          stageY: this.chainBase.y,
          pointFor: this.pointForChainNode,
        },
        reason,
      ),
    );
  }

  /**
   * Enables pointer input for every interactive widget below `root` and hooks the Phaser events.
   *
   * Call it after the tree exists (a `UIRoot`); widgets mounted later are picked up by `refresh()`.
   * `scene` defaults to the root's own scene, so the two-argument form is the explicit one and the
   * one-argument form is what a host uses when the root is already in the scene.
   */
  attach(root: Widget, scene?: Phaser.Scene): void {
    this.detach();
    this.rootWidget = root;
    this.scene = scene ?? liveSceneOf(root);
    // `topOnly` is left ON so that a press reaching the UI never also reaches the game object painted
    // underneath it (V9: a click on a HUD button used to fire the ground's handler too, because Phaser
    // dispatches to every object in the hit list when `topOnly` is off).
    //
    // This used to require `topOnly = false`: the router listened for the press *on the target widget*,
    // and with `topOnly` on, Phaser can hand the event to a container that happens to sort above its own
    // children (`#/scroll`'s step buttons went dead in the round-39 A/B). The handlers below no longer
    // care which widget Phaser picked - they resolve the target from the coordinates - so the topmost UI
    // object is enough to trigger routing, and the game objects never see the press.
    const input = this.scene?.input;
    if (input) {
      this.previousTopOnly = input.topOnly;
      input.topOnly = true;
    }
    this.refresh();
  }

  /**
   * Re-scans the tree: newly added interactive widgets are hooked, widgets that left the tree are
   * unhooked. Cheap enough to call after every structural change (mount/unmount), not per frame.
   */
  refresh(): void {
    if (!this.rootWidget) {
      return;
    }

    const wanted = collectInteractive(this.rootWidget);
    const wantedSet = new Set(wanted);

    for (const binding of [...this.bindings]) {
      if (!wantedSet.has(binding.widget)) {
        this.unregister(binding.widget);
      }
    }

    for (const widget of wanted) {
      if (!this.isRegistered(widget)) {
        this.register(widget);
      }
    }
  }

  /**
   * Sets (or clears) the capture widget — a modal overlay, for example.
   *
   * While a capture is set, pointer events on the widgets *underneath* its hit area are swallowed:
   * a click that lands inside the capture widget but outside its subtree does nothing, and click
   * that misses the capture widget entirely still reaches the rest of the UI (so a popup can be
   * dismissed by clicking the backdrop next to it).
   */
  setCapture(widget: Widget | null): void {
    if (widget) {
      // The hit test below needs the widget to have a hit area, and a modal mask is usually not
      // "interactive" in the routing sense (no focus, no activation), so it would not be enabled by
      // `refresh()`. Enabling input here does not add listeners: the mask stays out of the routed
      // set unless it also carries an activation callback or is focusable.
      enablePointerInput(widget);
    }
    if (this.captureWidget !== widget && this.hub.count > 0) {
      // The layer a gesture was being delivered to is no longer the top one (a modal opened, a page
      // was pushed): every gesture in flight is told, the way Android cancels the touches of the
      // window that just lost focus, instead of letting a hidden widget keep receiving moves.
      this.cancelAllChains('capture changed');
    }
    this.captureWidget = widget;
  }

  /**
   * Per-frame maintenance, called by the host plugin.
   *
   * Polls `Widget.enabled` (a widget disabled while hovered or pressed must drop both states), prunes
   * references to widgets that were destroyed without an explicit `refresh()`, and re-derives hover
   * and the press state from the live pointer (see `syncPointerState`).
   */
  update(_time = 0, _delta = 0): void {
    const widgets = this.widgetList();
    const stale = diffInteractionState(this.enabledState, widgets);
    for (const widget of stale) {
      this.resetInteraction(widget);
    }

    for (const widget of widgets) {
      this.enabledState.set(widget, widget.enabled);
      if (widget.isDestroyed || liveSceneOf(widget) === null) {
        this.unregister(widget);
      }
    }

    this.syncPointerState();
    this.updatePointerChains();
  }

  /**
   * Re-derives the pointer state of the tree: hover is *the deepest control under the pointer*, and a
   * press whose pointer is no longer down is stale.
   *
   * Both are states rather than event streams, which is what makes them self-correcting: a widget
   * that scrolls, is hidden, is rebuilt or is disabled under a stationary pointer drops its hover on
   * the next frame, and a press released outside every widget (Phaser delivers no `pointerup` to a
   * Game Object the pointer is not over) cannot stay pressed.
   *
   * The target is resolved first (that is what decides interception and activation) and then walked
   * *up* to the nearest control: a pure interception layer never lights up, and a control that
   * contains such a layer still does — the CSS `:hover` an author expects.
   */
  private syncPointerState(): void {
    const pointer = this.hoverPointer();
    const target = pointer ? this.pointerStateTarget(this.resolveTarget(pointer)) : null;
    if (target !== this.hoveredWidget) {
      const previous = this.hoveredWidget;
      this.hoveredWidget = target;
      if (previous && !previous.isDestroyed) {
        previous.setHovered(false);
      }
      if (target) {
        target.setHovered(true);
      }
    }

    for (const [widget, press] of [...this.pressedAt]) {
      if (press.pointer.isDown === true) {
        continue;
      }
      this.pressedAt.delete(widget);
      if (!widget.isDestroyed) {
        widget.setPressed(false);
      }
    }
  }

  /**
   * The control that owns the pointer states for a resolved target: the deepest ancestor-or-self
   * that can actually do something with them (see {@link takesPointerStates}).
   *
   * `null` when nothing in the chain is a control — the pointer is over a decoration, and no widget
   * should look pressed or hovered.
   */
  private pointerStateTarget(target: Widget | null): Widget | null {
    let current: Widget | null = target;
    while (current) {
      if (takesPointerStates(current)) {
        return current;
      }
      current = current.parentContainer as unknown as Widget | null;
    }
    return null;
  }

  /**
   * The pointer hover is derived from, or `null` when there is nothing to point with.
   *
   * The mouse pointer is used rather than `activePointer` because a *touch* leaves the pointer where
   * the finger lifted, which would pin a hover onto whatever is underneath (see `isHoverPointer`).
   */
  private hoverPointer(): Phaser.Input.Pointer | null {
    const manager = this.scene?.input?.manager;
    if (!manager || manager.isOver === false) {
      return null;
    }
    const pointer = manager.mousePointer;
    return isHoverPointer(pointer) ? pointer : null;
  }

  /**
   * Removes every listener and clears all references. Safe to call twice; call it from the scene's
   * `shutdown`/`destroy` handler so no listener outlives the UI.
   */
  detach(): void {
    if (this.scene?.input) {
      this.scene.input.topOnly = this.previousTopOnly;
    }
    for (const binding of [...this.bindings]) {
      this.unregister(binding.widget);
    }
    this.cancelAllChains('router detached');
    this.bindings = [];
    this.widgetCache = null;
    this.enabledState.clear();
    this.pressedAt.clear();
    this.chainOffsets.clear();
    this.chainLastAt.clear();
    this.hoveredWidget = null;
    this.captureWidget = null;
    this.rootWidget = null;
    this.scene = null;
  }

  // ------------------------------------------------------------------ internals

  private widgetList(): Widget[] {
    if (this.widgetCache === null) {
      this.widgetCache = this.bindings.map((binding) => binding.widget);
    }
    return this.widgetCache;
  }

  private isRegistered(widget: Widget): boolean {
    return this.bindings.some((binding) => binding.widget === widget);
  }

  private register(widget: Widget): void {
    enablePointerInput(widget);

    const binding: WidgetBinding = {
      widget,
      // The event is only a *signal* that a press happened inside the UI: which widget it belongs to is
      // decided by `resolveTarget` (coordinates), never by the object Phaser happened to dispatch to.
      onDown: (pointer) => {
        this.handlePointerDown(pointer);
      },
      onUp: (pointer) => {
        this.handlePointerUp(pointer);
      },
      onDestroy: () => {
        this.unregister(widget);
      },
    };

    widget.on(EVENT_DOWN, binding.onDown);
    widget.on(EVENT_UP, binding.onUp);
    widget.once(EVENT_DESTROY, binding.onDestroy);

    this.bindings.push(binding);
    this.widgetCache = null;
    this.enabledState.set(widget, widget.enabled);
  }

  private unregister(widget: Widget): void {
    const index = this.bindings.findIndex((binding) => binding.widget === widget);
    if (index === -1) {
      return;
    }

    const binding = this.bindings[index];
    this.bindings.splice(index, 1);
    this.widgetCache = null;

    if (binding) {
      widget.off(EVENT_DOWN, binding.onDown);
      widget.off(EVENT_UP, binding.onUp);
      widget.off(EVENT_DESTROY, binding.onDestroy);
    }

    this.resetInteraction(widget);
    this.enabledState.delete(widget);
    // The widget left the routed tree mid-gesture: the path the press established no longer exists, so
    // whoever owns it is told now rather than on the next frame (a stale owner would keep receiving
    // moves for a widget that is gone).
    this.cancelChainsThrough(widget, 'widget left the tree');
  }

  /** Drops hover/press state; used on disable, on destroy and on pointer-out. */

  // ------------------------------------------------------------------ the pointer event chain

  /**
   * The widget path a press at `widget` is delivered along: routed root → `widget`.
   *
   * This is Android's "hit path". It is rebuilt from `parentContainer` rather than recorded during the
   * hit test because the hit test may not even visit the ancestors that matter (it stops at the
   * deepest target), while the chain has to *ask* every one of them whether it wants to intercept.
   *
   * An empty result means "not part of the routed tree" — the press belongs to the game, not the UI.
   */
  private chainPathFor(widget: Widget): Widget[] {
    const root = this.rootWidget;
    if (!root) {
      return [];
    }
    const path: Widget[] = [];
    let current: Widget | null = widget;
    while (current) {
      // A node that is painted but not routed takes its whole subtree out of the chain, exactly like
      // the hit test does: a page fading out under the page above it is not a gesture target either.
      if (current.routingEnabled === false) {
        return [];
      }
      path.push(current);
      if (current === root) {
        break;
      }
      current = (current.parentContainer as unknown as Widget | null) ?? null;
    }
    if (path[path.length - 1] !== root) {
      return [];
    }
    path.reverse();
    return path;
  }

  /**
   * Fills the per-node offsets of a path, plus the pointer in the **routed root's** own space.
   *
   * The offset of a node is the sum of the positions of it and its ancestors, which is exactly what
   * `resolveTargetInTree` accumulates on its way down. Subtracting it from the root-space point gives
   * the point in that node's own space — so `event.x`/`event.y` a handler sees agree with the hit test
   * that decided this handler should run, in every nesting depth and under any camera pinning.
   */
  private prepareChainSpace(
    pointer: Phaser.Input.Pointer | null,
    path: readonly Widget[],
    fallback: ChainPoint | null,
  ): void {
    this.chainOffsets.clear();
    let offsetX = 0;
    let offsetY = 0;
    for (const node of path) {
      offsetX += node.x;
      offsetY += node.y;
      this.chainOffsets.set(node, { x: offsetX, y: offsetY });
    }

    const root = this.rootWidget;
    if (pointer && root) {
      const point = pointerInWidgetSpace(pointer, root, this.scene?.cameras.main ?? null);
      this.chainBase.x = point.x;
      this.chainBase.y = point.y;
      return;
    }
    this.chainBase.x = fallback?.x ?? 0;
    this.chainBase.y = fallback?.y ?? 0;
  }

  /** `touch` when the pointer came from a finger, `mouse` otherwise. */
  private pointerKind(
    pointer: Phaser.Input.Pointer | null,
    fallback: PointerKind = 'mouse',
  ): PointerKind {
    if (!pointer) {
      return fallback;
    }
    return pointer.wasTouch === true ? 'touch' : 'mouse';
  }

  /**
   * Dispatches one phase of a gesture through the chain.
   *
   * `target` is the freshly hit-tested widget and is only used for `down`: every later phase of a
   * gesture goes to the path the press established, which is what makes a drag survive the pointer
   * leaving the widget (or the nested port, or the canvas).
   */
  private dispatchChain(
    pointer: Phaser.Input.Pointer | null,
    phase: PointerPhase,
    target: Widget | null,
  ): PointerChainTrace | null {
    const root = this.rootWidget;
    if (!root) {
      return null;
    }

    const retained = pointer ? this.hub.active(pointer.id) : null;
    let path: readonly Widget[];
    if (phase === 'down') {
      path = target ? this.chainPathFor(target) : [];
      if (path.length === 0) {
        return null;
      }
    } else {
      if (!retained) {
        return null;
      }
      path = retained.path as readonly Widget[];
    }

    const origin = retained ? { x: retained.startX, y: retained.startY } : null;
    this.prepareChainSpace(pointer, path, origin);

    this.dispatchingPointerId = pointer?.id ?? retained?.pointerId ?? -1;
    const trace = this.hub.dispatch({
      phase,
      pointerId: pointer?.id ?? retained?.pointerId ?? -1,
      kind: this.pointerKind(pointer, retained?.kind),
      path,
      stageX: this.chainBase.x,
      stageY: this.chainBase.y,
      pointFor: this.pointForChainNode,
      disallowed: this.interceptDisallowed,
    });

    if (pointer) {
      let at = this.chainLastAt.get(pointer.id);
      if (at === undefined) {
        at = { x: pointer.x, y: pointer.y };
        this.chainLastAt.set(pointer.id, at);
      }
      at.x = pointer.x;
      at.y = pointer.y;
    }
    this.publishTrace(trace);
    return trace;
  }

  /** Records a trace, and keeps the "this gesture was consumed" bookkeeping in step with it. */
  private publishTrace(trace: PointerChainTrace): void {
    this.lastTrace = trace;
    if (trace.handledBy) {
      this.chainOwns.set(trace.pointerId, trace.handledBy as Widget);
    }
    if (trace.phase === 'up' || trace.phase === 'cancel') {
      this.chainOwns.delete(trace.pointerId);
      this.chainLastAt.delete(trace.pointerId);
    }
    this.onPointerChain?.(trace);
  }

  /**
   * Whether an ancestor may not intercept: a descendant of it owns this pointer.
   *
   * The registry is the drag-claim map (`pointer-claim.ts`), so `requestDisallowInterceptPointer` and
   * a `TextField` starting a selection are literally the same record — one answer to "who owns this
   * pointer", not two that can disagree.
   */
  private isInterceptDisallowed(widget: Widget): boolean {
    const owner = pointerDragOwner(this.scene, this.dispatchingPointerId);
    if (!owner || owner === widget) {
      return false;
    }
    return isWithinTree(owner as ContainerLike, widget as ContainerLike);
  }

  /**
   * Per-frame maintenance of the gestures in flight.
   *
   * This is where the "state, not stream" discipline pays off for the chain too: Phaser only emits
   * `pointermove`/`pointerup` *on a Game Object* while the pointer is over it, so a drag that leaves
   * the widget would simply stop receiving events. Polling the pointer each frame delivers moves to
   * the retained owner wherever it went, and turns a release nobody told us about (released over the
   * background, over a game object, outside the canvas) into the `up` the owner is waiting for.
   */
  private updatePointerChains(): void {
    if (this.hub.count === 0) {
      return;
    }
    for (const chain of this.hub.activeChains()) {
      const pointer = this.pointerById(chain.pointerId);
      if (!pointer) {
        this.cancelPointer(chain.pointerId, 'pointer gone');
        continue;
      }
      if (this.chainBroken(chain.path as readonly Widget[])) {
        this.cancelPointer(chain.pointerId, 'owner left the tree');
        continue;
      }
      if (pointer.isDown !== true) {
        // The release reached nobody: deliver it along the retained path and clear the gesture.
        this.dispatchChain(pointer, 'up', null);
        continue;
      }
      const last = this.chainLastAt.get(chain.pointerId);
      if (last && last.x === pointer.x && last.y === pointer.y) {
        continue;
      }
      this.dispatchChain(pointer, 'move', null);
    }
  }

  /** Whether any widget of a retained path is gone, hidden from routing, or detached from a scene. */
  private chainBroken(path: readonly Widget[]): boolean {
    for (const node of path) {
      if (node.isDestroyed || node.routingEnabled === false || liveSceneOf(node) === null) {
        return true;
      }
    }
    return false;
  }

  /** Phaser's pointer for an id, or `null` when the manager no longer tracks it. */
  private pointerById(pointerId: number): Phaser.Input.Pointer | null {
    const pointers = this.scene?.input?.manager?.pointers as
      (Phaser.Input.Pointer | undefined)[] | undefined;
    return pointers?.[pointerId] ?? null;
  }

  /** Ends every gesture that involves `widget` (it was unmounted, so the path no longer exists). */
  private cancelChainsThrough(widget: Widget, reason: string): void {
    for (const chain of this.hub.activeChains()) {
      if (chain.path.includes(widget)) {
        this.cancelPointer(chain.pointerId, reason);
      }
    }
  }

  /** Ends every gesture in flight, telling each owner why, and forgets the bookkeeping. */
  private cancelAllChains(reason: string): void {
    for (const pointerId of this.hub.pointerIds) {
      this.cancelPointer(pointerId, reason);
    }
    this.hub.clear();
    this.chainOwns.clear();
    this.chainLastAt.clear();
  }

  /**
   * Resolves which interactive widget owns a pointer position, **from the inside out**.
   *
   * Phaser's own `topOnly` dispatch cannot be relied on for UI trees: container children are not on
   * the scene display list, so their sort order against their own container is undefined and a panel
   * with a hit area can swallow its child buttons. Walking the widget tree front-to-back (last child
   * is drawn on top) gives the semantics a UI needs.
   */
  /**
   * The pointer in the space **one widget** is laid out in.
   *
   * `InputRouter` is the second gate: Phaser's own hit test decides whether a widget sees the event at
   * all, and `resolveTarget` then re-walks the tree. The two only agree if they use the same point, and
   * Phaser computes that point **per object** (`InputManager#hitTest`):
   *
   * ```js
   * px = pointer.worldX + camera.scrollX * gameObject.scrollFactorX - camera.scrollX;
   * ```
   *
   * So the factor that matters is the *candidate's own*, not the root's. The previous version keyed off
   * `rootWidget.scrollFactor*`, which broke every tree pinned below the root: `page.setScrollFactor(0)`
   * (a HUD page next to a world-space page) rendered pinned and passed Phaser's hit test, but this walk
   * still compared layout rects against `pointer.worldX/Y` and rejected the widget — visible, hit-testable
   * and yet dead. Mirroring the formula removes the class of bug instead of one instance of it.
   */
  private pointerInUiSpace(
    pointer: Phaser.Input.Pointer,
    widget: Widget,
  ): { x: number; y: number } {
    const point = pointerInWidgetSpace(pointer, widget, this.scene?.cameras.main ?? null);
    this.space.x = point.x;
    this.space.y = point.y;
    return this.space;
  }

  private resolveTarget(pointer: Phaser.Input.Pointer): Widget | null {
    const root = this.rootWidget;
    if (!root) {
      return null;
    }

    // The walk itself is pure and unit-tested (`resolveTargetInTree`); the two Phaser-flavoured bits
    // are injected: which point a *given* widget is tested against, and which widgets are targets.
    const target = resolveTargetInTree<Widget>(
      root,
      (widget) => this.pointerInUiSpace(pointer, widget),
      (widget) => this.isRegistered(widget) && widget.enabled !== false,
    );

    if (target && this.captureWidget && !isWithinTree(target, this.captureWidget)) {
      return null;
    }
    return target;
  }

  private resetInteraction(widget: Widget): void {
    this.pressedAt.delete(widget);
    if (this.hoveredWidget === widget) {
      this.hoveredWidget = null;
    }
    widget.setHovered(false);
    widget.setPressed(false);
  }

  /**
   * A press inside the UI subtree.
   *
   * The target comes from the coordinates; the widget that received the Phaser event is irrelevant (it
   * may be an ancestor, because `topOnly` is on). Returns the target so a caller can tell a landed press
   * from one that fell through to the game.
   */
  private handlePointerDown(pointer: Phaser.Input.Pointer): Widget | null {
    const widget = this.resolveTarget(pointer);
    if (widget === null) {
      return null;
    }
    if (this.isBlockedByCapture(widget, pointer)) {
      return widget;
    }
    if (!widget.enabled) {
      return widget;
    }

    // The chain runs *before* the press is recorded, so a widget that consumes the event has already
    // made the gesture its own by the time the click machinery looks at it. Nothing in the widget
    // library consumes pointer events by default, which is why this is additive: a tree with no chain
    // handlers behaves exactly as it did before the chain existed.
    const trace = this.dispatchChain(pointer, 'down', widget);
    if (trace !== null && trace.stop === 'intercepted') {
      // An ancestor took the gesture before the target heard about it (Android's
      // `onInterceptTouchEvent` returning `true`). The target never received a DOWN, so it must not be
      // left holding a press that would become a click on release, and focus stays where it was: the
      // user grabbed the container, not the control inside it. Measured on `#/events` — without this, an
      // `l2` that intercepted the press still let the leaf below it fire `onClick`.
      return widget;
    }

    const origin = this.pointerInUiSpace(pointer, widget);
    this.pressedAt.set(widget, { x: origin.x, y: origin.y, pointer });
    // The *press* is recorded for every target (that is what decides activation), but only a control
    // shows it: a pure interception layer that darkened on every click is the same defect as the
    // hover flash (see `takesPointerStates`).
    if (takesPointerStates(widget)) {
      widget.setPressed(true);
    }

    // Pressing a control gives it focus, the way every desktop toolkit behaves: the focus ring appears
    // where the user clicked and the next `Tab`/arrow continues from there. A press that turns into a
    // drag still focuses first — that is what the user grabbed.
    if (shouldFocusOnPress(widget)) {
      this.onPointerFocus?.(widget);
    }
    return widget;
  }

  /** A release inside the UI subtree: activate the widget this pointer pressed, if it is still the target. */
  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    // The chain hears about the release first, and *before* the gesture bookkeeping is cleared: this is
    // the moment a widget that consumed the press gets its `up`, whether or not the pointer is over it
    // (Phaser only delivers `pointerup` to a Game Object the pointer is still on, and a drag usually
    // ends somewhere else entirely).
    const wasOwned = this.chainOwns.has(pointer.id);
    const upTrace = this.dispatchChain(pointer, 'up', null);

    const target = this.resolveTarget(pointer);
    for (const [widget, down] of [...this.pressedAt]) {
      if (down.pointer !== pointer) {
        continue;
      }
      if (target !== widget) {
        // Released over a different (or deeper) widget, or outside every widget: no activation.
        this.resetInteraction(widget);
        continue;
      }
      this.resetInteraction(widget);

      if (this.isBlockedByCapture(widget, pointer) || !widget.enabled) {
        continue;
      }
      // Phaser only emits `pointerup` on an object when the pointer is still over it, so "released
      // inside the widget" is already guaranteed here; only the travel has to be checked.
      if (!isClickGesture(down, this.pointerInUiSpace(pointer, widget), this.dragThreshold)) {
        continue;
      }
      // A gesture the chain consumed is not a click as well: the widget (or the ancestor that
      // intercepted it) said it is handling this press itself. The press state, the focus and the
      // hover above are unaffected — the control really was pressed — only the activation is.
      if (wasOwned || upTrace?.handledBy) {
        continue;
      }

      // A touch is reported as its own source: `wasTouch` is the only reliable difference between a
      // finger and a mouse, and an app that adapts its hints to the device needs it here rather than
      // from Phaser's input behind the framework's back.
      const source: ActivationSource = pointer.wasTouch === true ? 'touch' : 'pointer';
      if (widget.activate(source)) {
        this.onActivate?.(widget, source);
      }

      // `resetInteraction` cleared hover above; a mouse click leaves the cursor inside the widget, so the
      // hover state has to be restored right away (the next frame's poll would do it a frame later,
      // which is visible as a flicker on a click). A *touch* has no cursor to leave behind - see
      // `keepsHoverAfterPress`. Which widget shows it is the same question the poll answers: the
      // nearest control (and nothing at all when the target is a decoration).
      const hovered = this.pointerStateTarget(widget);
      if (
        hovered &&
        widget.enabled &&
        keepsHoverAfterPress(pointer) &&
        this.resolveTarget(pointer) === widget
      ) {
        hovered.setHovered(true);
        this.hoveredWidget = hovered;
      }
    }
  }

  /**
   * True when the event must be swallowed because it belongs to a widget outside the capture
   * subtree while the pointer is inside the capture widget's hit area.
   */
  private isBlockedByCapture(widget: Widget, pointer: Phaser.Input.Pointer): boolean {
    const capture = this.captureWidget;
    if (!capture) {
      return false;
    }
    if (isWithinTree(widget, capture)) {
      return false;
    }
    return this.pointerHitsWidget(pointer, capture);
  }

  /**
   * Hit-tests a single widget.
   *
   * `InputManager.hitTest` is used instead of `InputPlugin.hitTestPointer` because the plugin's
   * variant writes into the very array the plugin is iterating while it dispatches this event; the
   * explicit output array here keeps that internal state untouched.
   */
  private pointerHitsWidget(pointer: Phaser.Input.Pointer, widget: Widget): boolean {
    const scene = this.scene;
    const input = scene?.input;
    if (!input) {
      return false;
    }
    const camera = pointer.camera ?? scene?.cameras.main;
    if (!camera) {
      return false;
    }

    this.hitInput.length = 0;
    this.hitInput.push(widget);
    this.hitOutput.length = 0;
    input.manager.hitTest(pointer, this.hitInput, camera, this.hitOutput);
    return this.hitOutput.length > 0;
  }
}

/**
 * Collects the widgets of a subtree that should receive pointer input: focusable ones, widgets with
 * an activation callback, and widgets flagged with an explicit `interactive` marker.
 */
export function collectInteractive(root: Widget): Widget[] {
  const found: Widget[] = [];

  const visit = (widget: Widget): void => {
    // Note what is *not* here: `routingEnabled`. That flag only steers the hit-test walk, so a subtree
    // that is painted but not routed stays in this collection — and therefore in the accessibility
    // mirror, where removing and re-creating thirteen nodes twice per page transition would be worse
    // than announcing a page that is still on screen.
    // `blockPointer` widgets (the default for panels) are collected too: they are not activatable,
    // but being a target is exactly what makes them swallow a pointer that would otherwise reach
    // whatever is painted behind them.
    if (
      widget.focusable === true ||
      widget.onActivate !== null ||
      hasInteractiveFlag(widget) ||
      hasBlockPointerFlag(widget)
    ) {
      found.push(widget);
    }
    for (const child of widget.getWidgetChildren()) {
      visit(child);
    }
  };

  visit(root);
  return found;
}
