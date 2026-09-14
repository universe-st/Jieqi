/**
 * The pointer event chain — dispatch, interception and consumption, modelled on Android's
 * `dispatchTouchEvent` / `onInterceptTouchEvent` / `onTouchEvent` trio.
 *
 * Why a chain at all: a hit test answers "which widget is under the pointer", and that is enough for a
 * single click on a leaf. It is not enough for anything that has to survive **nesting**. A `ScrollView`
 * inside a `ScrollView` inside a panel, a text field inside a scrolled form, a card inside a draggable
 * list — each of those needs three answers the hit test cannot give:
 *
 * - who gets the event first (the deepest widget, then its ancestors as it declines),
 * - who may *take it away* from a descendant that already has it (an ancestor that only now decides
 *   the gesture is a scroll),
 * - and what a descendant is told when that happens (a cancel, not a silently dropped stream).
 *
 * Android settled this with one ordered walk down the tree plus a return value:
 *
 * 1. `ACTION_DOWN` builds the path (root → deepest hit widget). Every *container* on the way down is
 *    asked `onInterceptTouchEvent` first; the first one that says `true` takes the event and the walk
 *    stops there. Otherwise the walk reaches the deepest widget, whose `onTouchEvent` decides: `true`
 *    consumes the event, `false` hands it back **up** the path (the parent's `onTouchEvent` runs, then
 *    its parent's, …).
 * 2. Whoever consumed the DOWN owns the gesture. `ACTION_MOVE`/`ACTION_UP` are delivered to that owner
 *    and its ancestors only — **never re-hit-tested**, so dragging a finger off a widget (or out of a
 *    nested port, or off the canvas) keeps feeding the widget that took the press. That is the
 *    stability property the whole design exists for.
 * 3. Any ancestor on the retained path may still intercept during a `move`. When it does, the current
 *    owner receives `ACTION_CANCEL` — "stop, someone above you took it" — and the interceptor becomes
 *    the owner.
 * 4. A descendant can veto step 3 for the whole gesture: `requestDisallowInterceptTouchEvent(true)`
 *    (here `Widget#requestDisallowInterceptPointer`). A text field starting a selection uses it, and it
 *    is the *same* claim the drag-ownership protocol already stores (`pointer-claim.ts`), so "who owns
 *    this gesture" keeps exactly one home.
 *
 * This module is the pure core: it walks a path of {@link PointerChainNode}s, calls their hooks and
 * keeps the per-pointer retained state. It has no Phaser import (not even a type one) and is unit
 * tested with plain objects. `InputRouter` is the adapter: it builds the path from the hit test,
 * converts the stage point into each node's own space, and answers `disallowed()` from the claim
 * registry.
 *
 * ## What a handler must not do
 *
 * The event object handed to every hook of one dispatch is **the same object, mutated** as the walk
 * moves from node to node (Android does the same with `MotionEvent` offsets). It exists to be read
 * inside the hook: keeping a reference to it and reading it later gives whatever the last visited node
 * saw. Copy the fields you need.
 */

/** Which moment of a gesture an event describes. */
export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

/** What produced the event. `touch` and `mouse` differ in the ways handlers care about. */
export type PointerKind = 'mouse' | 'touch';

/** A plain 2D point. */
export interface ChainPoint {
  x: number;
  y: number;
}

/**
 * One node of the delivery path.
 *
 * Structural on purpose (a `Widget` satisfies it without importing anything from here): the walk only
 * needs a box, the two hooks and the routing flag.
 */
export interface PointerChainNode {
  /** Used in traces and dev logs; falls back to `anonymous`. */
  readonly chainLabel?: string;
  /** Box assigned by the layout engine, which is how `inside` is computed. */
  appliedRect: { width: number; height: number };
  /** `false` takes the node *and its subtree* out of the chain (painted but not a pointer target). */
  routingEnabled?: boolean;
  /**
   * Android's `onInterceptTouchEvent`: asked on the way **down** (and again on every `move`) for every
   * node that still has a descendant on the path. Returning `true` takes the gesture away from
   * everything below it.
   */
  onPointerIntercept?: ((event: PointerChainEvent) => boolean | void) | null;
  /**
   * Android's `onTouchEvent`: the node's own handler. Returning `true` **consumes** the event, which
   * (on a `down`) makes this node the owner of the gesture and (on every phase) stops the walk.
   * Returning `false`/`undefined` lets an ancestor try.
   */
  onPointerEvent?: ((event: PointerChainEvent) => boolean | void) | null;
}

/**
 * The event every hook receives.
 *
 * Coordinates are **in the visited node's own space**, which is what makes a nested port usable without
 * the handler knowing where it sits: a `ScrollView` three levels deep gets the same `x`/`y` it would
 * get at the root. `stageX`/`stageY` are the untouched page-space point for the cases that need to
 * compare across nodes (hit slop, a drag that left the box).
 */
export interface PointerChainEvent {
  /** Which moment this is; `cancel` means "stop, an ancestor took the gesture". */
  readonly phase: PointerPhase;
  /** Phaser pointer id: a second finger is a second gesture, never the same one. */
  readonly pointerId: number;
  /** Mouse or touch. */
  readonly kind: PointerKind;
  /** The node whose hook is running right now. */
  readonly node: PointerChainNode;
  /** Depth of `node` on the path (`0` is the routed root). */
  readonly depth: number;
  /** Pointer position in `node`'s coordinate space. */
  readonly x: number;
  readonly y: number;
  /**
   * Pointer position in the **routed root's** own space (the page space of an unpinned tree, the screen
   * space of a camera-pinned one), identical for every node of one dispatch.
   */
  readonly stageX: number;
  readonly stageY: number;
  /** Whether the pointer is still inside `node`'s box (`false` is normal during a drag). */
  readonly inside: boolean;
  /** Movement since the gesture started, in stage pixels. */
  readonly dx: number;
  readonly dy: number;
  /** The node the pointer landed on when the gesture started (`null` when there is no path). */
  readonly hitTarget: PointerChainNode | null;
  /** The node that owned the gesture *before* this dispatch (`null` on the `down`). */
  readonly owner: PointerChainNode | null;
  /** Only for `phase: 'cancel'`: why the gesture was taken away. */
  readonly cancelReason: string | null;
}

/** What one node did with the event, in delivery order. */
export type PointerChainAction = 'intercept' | 'handle' | 'cancel';

/** A single line of the delivery log: "node X was asked Y and answered Z". */
export interface PointerChainEntry {
  readonly node: PointerChainNode;
  readonly label: string;
  readonly action: PointerChainAction;
  readonly depth: number;
  /** `true` when the node intercepted or consumed; `false` when it declined. */
  readonly result: boolean;
  /** Set on an interception that was forbidden by a descendant's disallow request. */
  readonly disallowed?: boolean;
}

/** Why the walk stopped where it did. */
export type PointerChainStop =
  /** A node consumed the event. */
  | 'handled'
  /** Every hook declined (or there was none). */
  | 'declined'
  /** A node intercepted: everything below it was skipped. */
  | 'intercepted'
  /** A cancel was delivered (or the chain was dropped without a handler to tell). */
  | 'cancelled'
  /** The path was empty — nothing to deliver to. */
  | 'no-path'
  /** No gesture in flight for this pointer id. */
  | 'no-chain';

/** The full record of one dispatch: the input to the demo's on-screen log and to the unit tests. */
export interface PointerChainTrace {
  readonly phase: PointerPhase;
  readonly pointerId: number;
  readonly kind: PointerKind;
  /** Hooks that ran, in the order they ran. */
  readonly entries: readonly PointerChainEntry[];
  /** The node that consumed the event, or `null` when nobody did. */
  readonly handledBy: PointerChainNode | null;
  /** The deepest node of the input path (what the hit test found). */
  readonly hitTarget: PointerChainNode | null;
  /** The node that owns the gesture after this dispatch. */
  readonly owner: PointerChainNode | null;
  readonly stop: PointerChainStop;
  readonly cancelReason: string | null;
  /** Length of the path the event was delivered along. */
  readonly pathLength: number;
}

/** Everything one dispatch needs from the adapter. */
export interface PointerChainInput {
  readonly phase: PointerPhase;
  readonly pointerId: number;
  readonly kind: PointerKind;
  /** Root → hit target. Nodes with `routingEnabled === false` must already be filtered out. */
  readonly path: readonly PointerChainNode[];
  /** Pointer position in page/stage space. */
  readonly stageX: number;
  readonly stageY: number;
  /** The pointer in **one node's** own coordinate space (the same conversion the hit test used). */
  pointFor(node: PointerChainNode): ChainPoint;
  /**
   * Whether an ancestor must not intercept this event, because a descendant owns the gesture
   * (`requestDisallowInterceptTouchEvent`). Asked fresh on every dispatch, never cached here.
   */
  disallowed?(node: PointerChainNode): boolean;
}

/** A gesture still in flight: the pointer id, the path it was built from and its owner. */
export interface RetainedPointerChain {
  readonly pointerId: number;
  readonly kind: PointerKind;
  /** Root → hit target as it was when the press landed. */
  readonly path: readonly PointerChainNode[];
  /** The node that consumed the DOWN; it receives every later phase until it is taken away. */
  readonly owner: PointerChainNode;
  readonly hitTarget: PointerChainNode;
  readonly startX: number;
  readonly startY: number;
}

/**
 * The mutable half of {@link PointerChainEvent}: the walk rewrites these before each hook.
 *
 * The public interface keeps them `readonly` so a handler cannot corrupt the next node's view, and the
 * hub writes through this view instead.
 */
interface MutableChainEvent extends PointerChainEvent {
  node: PointerChainNode;
  depth: number;
  x: number;
  y: number;
  inside: boolean;
  cancelReason: string | null;
}

/** The name a node is reported under. */
export function chainLabelOf(node: PointerChainNode): string {
  const label = node.chainLabel;
  return typeof label === 'string' && label.length > 0 ? label : 'anonymous';
}

/** Delivers pointer events along a widget path, Android style. */
export class PointerChainHub {
  private readonly chains = new Map<number, RetainedPointerChain>();

  /** The gesture in flight for a pointer id, or `null`. */
  active(pointerId: number): RetainedPointerChain | null {
    return this.chains.get(pointerId) ?? null;
  }

  /** Every gesture in flight, for diagnostics. */
  activeChains(): RetainedPointerChain[] {
    return [...this.chains.values()];
  }

  /** Pointer ids with a gesture in flight. */
  get pointerIds(): number[] {
    return [...this.chains.keys()];
  }

  /** How many gestures are in flight (the router checks this before doing any per-frame work). */
  get count(): number {
    return this.chains.size;
  }

  /** Forgets every gesture without delivering anything (scene shutdown). */
  clear(): void {
    this.chains.clear();
  }

  /** Delivers one phase of a gesture. */
  dispatch(input: PointerChainInput): PointerChainTrace {
    if (input.phase === 'cancel') {
      return this.cancel(input.pointerId, input, 'cancelled');
    }
    if (input.phase === 'down') {
      return this.dispatchDown(input);
    }
    return this.dispatchRetained(input);
  }

  /**
   * Cancels a gesture: the owner is told (`phase: 'cancel'`) and the chain is forgotten.
   *
   * Used for everything that takes a gesture away mid-flight — an ancestor intercepting, the widget
   * being destroyed or hidden, the modal layer changing, the scene shutting down. `input` is only
   * needed to locate the pointer; its `path` is ignored.
   */
  cancel(
    pointerId: number,
    input?: Partial<PointerChainInput>,
    reason = 'cancelled',
  ): PointerChainTrace {
    const chain = this.chains.get(pointerId);
    if (!chain) {
      return emptyTrace('cancel', pointerId, input?.kind ?? 'mouse', 'no-chain', 0, null, reason);
    }
    this.chains.delete(pointerId);

    const kind = chain.kind;
    const depth = Math.max(0, chain.path.indexOf(chain.owner));
    const stageX = input?.stageX ?? chain.startX;
    const stageY = input?.stageY ?? chain.startY;
    const event = makeEvent(input, kind, 'cancel', chain, stageX, stageY);
    event.cancelReason = reason;

    const entries: PointerChainEntry[] = [];
    const handler = chain.owner.onPointerEvent ?? null;
    if (handler) {
      const point = pointForNode(input, chain.owner, chain.startX, chain.startY);
      visit(event, chain.owner, depth, point);
      entries.push({
        node: chain.owner,
        label: chainLabelOf(chain.owner),
        action: 'cancel',
        depth,
        result: handler(event) === true,
      });
    }

    return {
      phase: 'cancel',
      pointerId,
      kind,
      entries,
      handledBy: null,
      hitTarget: chain.hitTarget,
      owner: null,
      stop: 'cancelled',
      cancelReason: reason,
      pathLength: chain.path.length,
    };
  }

  /** Cancels every gesture in flight (scene shutdown, `detach()`). */
  cancelAll(reason = 'cancelled'): PointerChainTrace[] {
    return this.pointerIds.map((pointerId) => this.cancel(pointerId, undefined, reason));
  }

  // ------------------------------------------------------------------ internals

  private dispatchDown(input: PointerChainInput): PointerChainTrace {
    // A gesture for this pointer that never got its UP (a lost release, a rebuilt tree) is dropped
    // silently: its owner is about to be pressed again, and a `cancel` would arrive first and be
    // reported as a state transition nobody made.
    this.chains.delete(input.pointerId);

    const path = input.path;
    if (path.length === 0) {
      return emptyTrace('down', input.pointerId, input.kind, 'no-path', 0, null);
    }
    const hitTarget = path[path.length - 1] as PointerChainNode;
    const entries: PointerChainEntry[] = [];
    const event = makeEvent(input, input.kind, 'down', null, input.stageX, input.stageY);

    // --- pass 1: interception, root → just above the hit target --------------------------------
    let start = path.length - 1;
    for (let depth = 0; depth < path.length - 1; depth++) {
      const node = path[depth] as PointerChainNode;
      const intercept = node.onPointerIntercept ?? null;
      if (!intercept) {
        continue;
      }
      if (input.disallowed?.(node) === true) {
        // A descendant (a text field, a nested port) owns this pointer: the ancestor may not take it
        // away. Recorded so the trace says *why* nothing intercepted.
        entries.push({
          node,
          label: chainLabelOf(node),
          action: 'intercept',
          depth,
          result: false,
          disallowed: true,
        });
        continue;
      }
      visit(event, node, depth, input.pointFor(node));
      const result = intercept(event) === true;
      entries.push({ node, label: chainLabelOf(node), action: 'intercept', depth, result });
      if (result) {
        start = depth;
        break;
      }
    }

    // --- pass 2: handling, from wherever pass 1 stopped, bubbling up ---------------------------
    const handledBy = this.runHandlers(path, start, event, input, entries);
    const stop: PointerChainStop =
      handledBy !== null ? 'handled' : start === path.length - 1 ? 'declined' : 'intercepted';

    if (handledBy === null) {
      return {
        phase: 'down',
        pointerId: input.pointerId,
        kind: input.kind,
        entries,
        handledBy: null,
        hitTarget,
        owner: null,
        stop,
        cancelReason: null,
        pathLength: path.length,
      };
    }

    this.chains.set(input.pointerId, {
      pointerId: input.pointerId,
      kind: input.kind,
      path,
      owner: handledBy,
      hitTarget,
      startX: input.stageX,
      startY: input.stageY,
    });

    return {
      phase: 'down',
      pointerId: input.pointerId,
      kind: input.kind,
      entries,
      handledBy,
      hitTarget,
      owner: handledBy,
      stop,
      cancelReason: null,
      pathLength: path.length,
    };
  }

  private dispatchRetained(input: PointerChainInput): PointerChainTrace {
    const chain = this.chains.get(input.pointerId);
    if (!chain) {
      return emptyTrace(input.phase, input.pointerId, input.kind, 'no-chain', 0, null);
    }

    let ownerIndex = chain.path.indexOf(chain.owner);
    if (ownerIndex < 0) {
      // The owner left the tree between two phases (a rebuilt subtree): nothing to deliver to.
      this.chains.delete(input.pointerId);
      return emptyTrace(
        input.phase,
        input.pointerId,
        chain.kind,
        'no-chain',
        chain.path.length,
        chain.hitTarget,
      );
    }

    const entries: PointerChainEntry[] = [];
    const event = makeEvent(input, chain.kind, input.phase, chain, input.stageX, input.stageY);

    // --- interception: only the ancestors of the current owner can take the gesture ------------
    let intercepted = false;
    let interceptor: PointerChainNode | null = null;
    for (let depth = 0; depth < ownerIndex; depth++) {
      const node = chain.path[depth] as PointerChainNode;
      const intercept = node.onPointerIntercept ?? null;
      if (!intercept) {
        continue;
      }
      if (input.disallowed?.(node) === true) {
        entries.push({
          node,
          label: chainLabelOf(node),
          action: 'intercept',
          depth,
          result: false,
          disallowed: true,
        });
        continue;
      }
      visit(event, node, depth, input.pointFor(node));
      const result = intercept(event) === true;
      entries.push({ node, label: chainLabelOf(node), action: 'intercept', depth, result });
      if (result) {
        // The gesture changes hands: the old owner is told, then the interceptor handles it.
        const cancelEntry = this.cancelForIntercept(input, chain, node);
        if (cancelEntry) {
          entries.push(cancelEntry);
        }
        ownerIndex = depth;
        intercepted = true;
        interceptor = node;
        break;
      }
    }

    const handledBy = this.runHandlers(chain.path, ownerIndex, event, input, entries);

    // The owner only changes when somebody *above* consumed the event; a `move` nobody handles leaves
    // the gesture with whoever took the DOWN (Android's `mFirstTouchTarget`).
    const nextOwner: PointerChainNode =
      handledBy ?? (intercepted && interceptor ? interceptor : chain.owner);
    const stop: PointerChainStop =
      handledBy !== null ? 'handled' : intercepted ? 'intercepted' : 'declined';

    if (input.phase === 'up') {
      this.chains.delete(input.pointerId);
    } else if (this.chains.get(input.pointerId) === chain) {
      // Only while this dispatch is still the current one: a handler is free to cancel (an ancestor
      // that took the gesture, a widget that closed a dialog, a host that ended the gesture), and
      // writing the chain back afterwards would resurrect a gesture somebody just ended.
      this.chains.set(input.pointerId, { ...chain, owner: nextOwner });
    }

    return {
      phase: input.phase,
      pointerId: input.pointerId,
      kind: chain.kind,
      entries,
      handledBy,
      hitTarget: chain.hitTarget,
      owner: nextOwner,
      stop,
      cancelReason: null,
      pathLength: chain.path.length,
    };
  }

  /** Walks up from `start` calling `onPointerEvent`; the first `true` wins and stops the walk. */
  private runHandlers(
    path: readonly PointerChainNode[],
    start: number,
    event: MutableChainEvent,
    input: PointerChainInput,
    entries: PointerChainEntry[],
  ): PointerChainNode | null {
    for (let depth = start; depth >= 0; depth--) {
      const node = path[depth] as PointerChainNode;
      const handler = node.onPointerEvent ?? null;
      if (!handler) {
        continue;
      }
      visit(event, node, depth, input.pointFor(node));
      const result = handler(event) === true;
      entries.push({ node, label: chainLabelOf(node), action: 'handle', depth, result });
      if (result) {
        return node;
      }
    }
    return null;
  }

  /** Tells the previous owner that an ancestor took the gesture; returns the trace line it adds. */
  private cancelForIntercept(
    input: PointerChainInput,
    chain: RetainedPointerChain,
    interceptor: PointerChainNode,
  ): PointerChainEntry | null {
    const previousOwner = chain.owner;
    const handler = previousOwner.onPointerEvent ?? null;
    if (!handler) {
      return null;
    }
    const event = makeEvent(input, chain.kind, 'cancel', chain, input.stageX, input.stageY);
    event.cancelReason = `intercepted by ${chainLabelOf(interceptor)}`;
    visit(event, previousOwner, 0, input.pointFor(previousOwner));
    const result = handler(event) === true;
    return {
      node: previousOwner,
      label: chainLabelOf(previousOwner),
      action: 'cancel',
      depth: Math.max(0, chain.path.indexOf(previousOwner)),
      result,
    };
  }
}

/** An empty trace, used when there is nothing to dispatch. */
function emptyTrace(
  phase: PointerPhase,
  pointerId: number,
  kind: PointerKind,
  stop: PointerChainStop,
  pathLength: number,
  hitTarget: PointerChainNode | null,
  reason: string | null = null,
): PointerChainTrace {
  return {
    phase,
    pointerId,
    kind,
    entries: [],
    handledBy: null,
    hitTarget,
    owner: null,
    stop,
    cancelReason: reason,
    pathLength,
  };
}

/** Builds the one event object of a dispatch (see the module comment on why it is reused). */
function makeEvent(
  input: PointerChainInput | Partial<PointerChainInput> | undefined,
  kind: PointerKind,
  phase: PointerPhase,
  chain: RetainedPointerChain | null,
  stageX: number,
  stageY: number,
): MutableChainEvent {
  const startX = chain?.startX ?? stageX;
  const startY = chain?.startY ?? stageY;
  return {
    phase,
    pointerId: input?.pointerId ?? chain?.pointerId ?? -1,
    kind,
    node: chain?.owner ?? ({ appliedRect: { width: 0, height: 0 } } as PointerChainNode),
    depth: 0,
    x: 0,
    y: 0,
    stageX,
    stageY,
    inside: false,
    dx: stageX - startX,
    dy: stageY - startY,
    hitTarget: chain?.hitTarget ?? null,
    owner: chain?.owner ?? null,
    cancelReason: null,
  };
}

/** The point a single node is tested against; falls back to the gesture's origin without an adapter. */
function pointForNode(
  input: Partial<PointerChainInput> | undefined,
  node: PointerChainNode,
  fallbackX: number,
  fallbackY: number,
): ChainPoint {
  return input?.pointFor ? input.pointFor(node) : { x: fallbackX, y: fallbackY };
}

/**
 * Rewrites the per-node half of the event.
 *
 * `inside` compares the local point against the node's own box, exactly like the hit-test walk
 * (`resolveTargetInTree`) does, so "the pointer is still on the widget that owns the gesture" and "the
 * hit test says this widget is under the pointer" can never disagree.
 */
function visit(
  event: MutableChainEvent,
  node: PointerChainNode,
  depth: number,
  point: ChainPoint,
): void {
  const rect = node.appliedRect;
  event.node = node;
  event.depth = depth;
  event.x = point.x;
  event.y = point.y;
  event.inside = point.x >= 0 && point.x <= rect.width && point.y >= 0 && point.y <= rect.height;
}
