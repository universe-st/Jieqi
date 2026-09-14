/**
 * The layout engine: measure/arrange passes, measurement caching, dirty propagation and snapping.
 *
 * Design notes
 * ------------
 * - A node's measured size is a pure function of `(constraint, percent base, node.revision)`, which
 *   makes the measurement cache sound. The cache is per node and keyed by the constraint *and* the
 *   containing block, because the same constraint resolves percentages differently against a
 *   different base.
 * - Dirty marks are consumed at the *start* of a pass, so an `invalidate()` raised while the pass
 *   runs (from `measureContent`, `applyRect` or a synchronous watcher) survives into the next pass
 *   instead of being wiped by the pass that never saw it.
 * - `invalidate(node)` walks up the parent chain marking nodes dirty; clean nodes with an
 *   unchanged rect are skipped entirely, so a small change costs O(depth + changed subtree)
 *   instead of O(tree).
 * - The upward walk stops *measuring* at a relayout boundary but keeps collecting the ancestors
 *   above it in `dirtyPath`, so the arrange pass still descends to the boundary (see `invalidate`).
 * - Layout is sub-pixel; snapping happens once, in `arrangeNode`, right before `applyRect`.
 * - Nothing in here allocates per frame once warmed up: contexts, child records and rects are
 *   pooled per node.
 */

import {
  type BoxConstraints,
  constraintsKey,
  deflate,
  enforce,
  loosen,
  unbounded,
} from './constraint';
import { type Rect, type Size, type SnapMode, clamp, copyRect, rectEquals, snapRect } from './geom';
import { type LengthUnit, type ResolvedParams, resolveLength } from './params';
import type {
  ArrangerContext,
  ContainerLayout,
  LayoutChild,
  LayoutNode,
  MeasureChildFn,
  PlaceChildFn,
} from './types';
import { arrangeBox, measureBox } from './box';
import { arrangeGrid, measureGrid } from './grid';
import { arrangeScroll, measureScroll } from './scroll';
import { arrangeAbsolute, measureAbsolute } from './stack';
import { arrangeStack, measureStack } from './stack';

export interface LayoutEngineOptions {
  /** Device pixel ratio used by snapping. Defaults to 1. */
  dpr?: number;
  /** Snapping mode applied to the final rects. Defaults to `'round'`. */
  snapMode?: SnapMode;
}

export interface LayoutEngineStats {
  passes: number;
  measureCalls: number;
  cacheHits: number;
  arrangeCalls: number;
  placedChildren: number;
  skippedSubtrees: number;
  snappedRects: number;
}

interface CacheEntry {
  revision: number;
  size: Size;
}

/** A snapped rect plus the `reset()` generation it was produced in (see `placeChildOf`). */
interface AppliedRect extends Rect {
  generation: number;
}

/** Only this many distinct constraints are cached per node; prevents unbounded growth. */
const MAX_CACHE_ENTRIES_PER_NODE = 24;

const ZERO_SIZE: Size = Object.freeze({ width: 0, height: 0 });
const ZERO_RECT: Rect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

class ChildRecord implements LayoutChild {
  node: LayoutNode = null as unknown as LayoutNode;
  params: ResolvedParams = null as unknown as ResolvedParams;
  index = 0;
  measured: Size = { width: 0, height: 0 };
  rect: Rect = { x: 0, y: 0, width: 0, height: 0 };

  reset(node: LayoutNode, index: number, measuring: boolean): void {
    this.node = node;
    this.params = node.layoutParams;
    this.index = index;
    // Only the measure pass writes `measured`; the arrange pass reads it back (arrangers size
    // `auto` children through `resolveOuterSize`), so it has to survive into the arrange pass.
    if (measuring) {
      this.measured.width = 0;
      this.measured.height = 0;
    }
    this.rect.x = 0;
    this.rect.y = 0;
    this.rect.width = 0;
    this.rect.height = 0;
  }
}

class EngineContext implements ArrangerContext {
  node: LayoutNode | null = null;
  children: ChildRecord[] = [];
  rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  constraint: BoxConstraints = unbounded();
  contentSize: Size = { width: 0, height: 0 };
  measuring = true;
  readonly measureChild: MeasureChildFn;
  readonly placeChild: PlaceChildFn;

  constructor(private readonly engine: LayoutEngine) {
    this.measureChild = (child, constraint) => engine.measureChildOf(this, child, constraint);
    this.placeChild = (child, rect) => engine.placeChildOf(this, child, rect);
  }

  resolveOuterSize(child: LayoutChild): Size {
    return this.engine.resolveOuterSizeOf(this, child);
  }

  isFill(child: LayoutChild, axis: 'horizontal' | 'vertical'): boolean {
    const unit = axis === 'horizontal' ? child.params.width : child.params.height;
    return unit === 'fill';
  }
}

export class LayoutEngine {
  dpr: number;
  snapMode: SnapMode;

  readonly stats: LayoutEngineStats = {
    passes: 0,
    measureCalls: 0,
    cacheHits: 0,
    arrangeCalls: 0,
    placedChildren: 0,
    skippedSubtrees: 0,
    snappedRects: 0,
  };

  private caches = new WeakMap<LayoutNode, Map<string, CacheEntry>>();
  private readonly records = new WeakMap<LayoutNode, ChildRecord[]>();
  private readonly appliedRects = new WeakMap<LayoutNode, AppliedRect>();
  private readonly dirty = new WeakSet<LayoutNode>();
  private readonly dirtyPending: LayoutNode[] = [];
  /**
   * Ancestors *above* a relayout boundary that the arrange pass still has to walk through.
   *
   * They are deliberately kept out of `dirty`: a dirty node misses the measurement cache, so marking
   * them would re-measure everything above the boundary and destroy the optimisation the boundary
   * promises (a change inside a fixed-size panel must not cost the page a measure). `dirtyPath` only
   * relaxes the *arrange* skip in `placeChildOf()`, which is what lets the walk reach the boundary
   * at all.
   *
   * A plain `Set` rather than a `WeakSet`: it is emptied when a pass starts (`beginPass()`), so it
   * holds references only between an invalidation and the pass that consumes it - the same lifetime
   * `dirtyPending` already has.
   */
  private readonly dirtyPath = new Set<LayoutNode>();
  private readonly contextPool: EngineContext[] = [];

  /**
   * Marks consumed by the pass that is running right now.
   *
   * The measure cache and the arrange skip read these instead of `dirty`/`dirtyPath`, which are the
   * marks waiting for the *next* pass. Keeping the two apart is what makes an in-pass `invalidate()`
   * both effective (it is honoured by the next pass) and non-destructive (this pass keeps the marks it
   * started with).
   */
  private readonly activeDirty = new Set<LayoutNode>();
  private readonly activeDirtyPath = new Set<LayoutNode>();

  /** Bumped by a global `reset()`; a stored rect from an older generation never satisfies a skip. */
  private generation = 0;

  private contextDepth = 0;
  private passRunning = false;

  constructor(options: LayoutEngineOptions = {}) {
    // A non-positive/non-finite dpr turns every snapped rect into `NaN` (`Math.round(v * dpr) / dpr`),
    // so it is clamped to the safe default instead of being propagated.
    const dpr = options.dpr ?? 1;
    this.dpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    this.snapMode = options.snapMode ?? 'round';
  }

  /**
   * Lays out `root` inside `constraint` and returns the root's resulting size.
   *
   * `percentBase` is the containing block used to resolve the root's own percentage lengths
   * (e.g. a UIRoot that is 100% of the camera); it defaults to the constraint's maximum.
   */
  layout(root: LayoutNode, constraint: BoxConstraints, percentBase?: Size): Size {
    this.stats.passes++;

    // A nested pass (a widget laying out a subtree from inside `measureContent`/`applyRect`) belongs
    // to the outer pass: consuming marks there would move work out from under the pass already
    // running.
    const outermost = !this.passRunning;
    if (outermost) {
      this.passRunning = true;
      this.beginPass();
    }

    try {
      this.contextDepth = 0;
      const base = percentBase ?? percentBaseOf(constraint);
      const rootSize = this.measureNode(root, constraint, base);

      this.contextDepth = 0;
      const rootRect: Rect = { x: 0, y: 0, width: rootSize.width, height: rootSize.height };
      this.arrangeRoot(root, rootRect);

      // Copied out: the cached size object belongs to the cache, and a caller mutating it would
      // poison every later pass that hits the same cache entry.
      return { width: rootSize.width, height: rootSize.height };
    } finally {
      if (outermost) {
        this.passRunning = false;
      }
    }
  }

  /**
   * Consumes the marks collected since the last pass.
   *
   * Anything raised *while* the pass runs stays in `dirty`/`dirtyPath`, so `hasDirtyNodes` reports it
   * and the host runs one more pass; previously every mark was cleared at the end of a pass, so an
   * in-pass invalidation disappeared without a trace and left permanently stale geometry.
   */
  private beginPass(): void {
    this.activeDirty.clear();
    for (let i = 0; i < this.dirtyPending.length; i++) {
      const node = this.dirtyPending[i] as LayoutNode;
      this.activeDirty.add(node);
      this.dirty.delete(node);
    }
    this.dirtyPending.length = 0;

    this.activeDirtyPath.clear();
    for (const node of this.dirtyPath) {
      this.activeDirtyPath.add(node);
    }
    this.dirtyPath.clear();
  }

  /**
   * Marks `node` and its ancestors dirty, stopping *at* a relayout boundary.
   *
   * Ancestors must be marked because (a) an auto-sized ancestor's measurement depends on its
   * children's sizes, and (b) the arrange pass walks down from the root and skips clean subtrees,
   * so a dirty node deep in the tree would otherwise never be re-arranged.
   *
   * A node declaring `isRelayoutBoundary` promises that its own size does not depend on its parent's
   * constraint, so the *measurement* walk ends there: the boundary and its subtree are recalculated,
   * while the ancestors above it answer from the measurement cache. Their measurements stay valid —
   * but they still have to be *walked through* by the arrange pass, otherwise the skip in
   * `placeChildOf()` would prune the branch and the boundary would never see its new rect. Those
   * ancestors are therefore collected in `dirtyPath`, which affects nothing but that skip.
   */
  invalidate(node: LayoutNode): void {
    let current: LayoutNode | null = node;
    let aboveBoundary = false;
    while (current && (aboveBoundary || !this.dirty.has(current))) {
      if (aboveBoundary) {
        // Above a boundary: the arrange has to descend through, the measurement cache stays valid.
        this.dirtyPath.add(current);
      } else {
        this.dirty.add(current);
        this.dirtyPending.push(current);
        if (current !== node && current.isRelayoutBoundary === true) {
          aboveBoundary = true;
        }
      }
      current = current.parent ?? null;
    }
  }

  /** Whether this specific node's cached measurement (or its subtree) is stale. */
  isDirty(node: LayoutNode): boolean {
    return this.dirty.has(node);
  }

  /**
   * Whether *any* node is stale, i.e. whether `layout()` has work to do.
   *
   * This is the entry point hosts must use before deciding to skip a pass: with relayout
   * boundaries, a change deep inside a fixed-size panel does not mark the root dirty, so
   * `isDirty(root)` alone would silently skip the pass and leave the UI stale.
   *
   * `dirtyPath` does not have to be folded in: `invalidate()` always marks the node it was called
   * with (unless that node is already dirty from this same pass, which `dirtyPending` already
   * records), so any pending arrange implies a pending `dirtyPending` entry as well. Hosts can keep
   * asking this one question.
   */
  get hasDirtyNodes(): boolean {
    return this.dirtyPending.length > 0;
  }

  /**
   * Drops cached measurements for a subtree (used when fonts/themes change globally).
   *
   * Dropping the cache alone is not enough: a node whose content *size* changed without a revision
   * bump (exactly what an external font change does) still looks "clean" to the arrange skip and would
   * keep its old rect forever. A subtree reset therefore marks the subtree dirty too, and the global
   * form bumps the generation so every stored rect has to be produced again by the next pass.
   */
  reset(node?: LayoutNode): void {
    if (!node) {
      // A WeakMap cannot be cleared, so re-point it and let the old one be collected.
      this.caches = new WeakMap();
      this.generation++;
      return;
    }
    this.dropCachesIn(node);
    this.markSubtreeDirty(node);
    this.invalidate(node);
  }

  /** Deletes the measurement cache of `node` and of every descendant. */
  private dropCachesIn(node: LayoutNode): void {
    this.caches.delete(node);
    for (let i = 0; i < node.children.length; i++) {
      this.dropCachesIn(node.children[i] as LayoutNode);
    }
  }

  /** Marks `node` and every descendant dirty, so both passes recompute the subtree. */
  private markSubtreeDirty(node: LayoutNode): void {
    if (!this.dirty.has(node)) {
      this.dirty.add(node);
      this.dirtyPending.push(node);
    }
    for (let i = 0; i < node.children.length; i++) {
      this.markSubtreeDirty(node.children[i] as LayoutNode);
    }
  }

  // ---------------------------------------------------------------- measure pass

  private measureNode(node: LayoutNode, constraint: BoxConstraints, base: Size): Size {
    if (!node.inFlow) {
      return ZERO_SIZE;
    }

    const params = node.layoutParams;
    const fixedWidth = resolveOwnLength(
      params.width,
      params.widthMin,
      params.widthMax,
      base.width,
      params.minWidth,
      params.maxWidth,
    );
    const fixedHeight = resolveOwnLength(
      params.height,
      params.heightMin,
      params.heightMax,
      base.height,
      params.minHeight,
      params.maxHeight,
    );

    const own: BoxConstraints = {
      minWidth: fixedWidth ?? Math.max(constraint.minWidth, params.minWidth),
      maxWidth: fixedWidth ?? Math.min(constraint.maxWidth, params.maxWidth),
      minHeight: fixedHeight ?? Math.max(constraint.minHeight, params.minHeight),
      maxHeight: fixedHeight ?? Math.min(constraint.maxHeight, params.maxHeight),
    };
    enforce(own);

    const dirty = this.activeDirty.has(node) || this.dirty.has(node);
    const cache = this.cacheFor(node);
    // The key carries the containing block: `width: '50%'` resolved against a 400px base is a
    // different answer from the same constraint resolved against a 100px base, and `layout()` exposes
    // the base as a parameter.
    const key = cacheKeyOf(own, base);
    const cached = cache.get(key);
    if (cached && !dirty && cached.revision === node.revision) {
      this.stats.cacheHits++;
      return cached.size;
    }

    this.stats.measureCalls++;

    const content = deflate(own, params.padding);
    let contentWidth: number;
    let contentHeight: number;

    if (node.container && node.children.length > 0) {
      // Constraints flow down, but a container's children are never *forced* to fill it: the flow
      // arrangers measure at-most and hand out the leftover in the arrange pass (`grow`/`shrink`,
      // `alignSelf`/`alignItems: 'stretch'`). A tight container (fixed width/height, or a tight
      // incoming constraint) would otherwise stretch every `auto` child to its own size.
      // `contentSize` keeps the real (max) extent, so percentages and `fill` still resolve against
      // the container's content box, and `content` is still what the result is clamped into.
      const ctx = this.acquireContext(
        node,
        ZERO_RECT,
        loosen(content),
        contentBaseOf(content, base),
        true,
      );
      const measured = this.measureContainer(node.container, ctx);
      // The flow arrangers skip `position: 'absolute'` children, so nobody else would measure them
      // and `arrangeAbsolute` (which only reads `child.measured`) would place them at 0×0. A `scroll`
      // port is deliberately excluded: its own measure covers every child, and measuring the holder a
      // second time here would overwrite the unbounded (natural) length it just established with the
      // port's own clamped one — which is exactly how content taller than the viewport got squashed.
      if (skipsAbsoluteChildren(node.container)) {
        for (let i = 0; i < ctx.children.length; i++) {
          const child = ctx.children[i] as ChildRecord;
          if (child.params.position === 'absolute') {
            this.measureChildOf(ctx, child, ctx.constraint);
          }
        }
      }
      // Released only now: the absolute pass above still walks this context's child records.
      this.releaseContext(ctx);
      contentWidth = clamp(measured.width, content.minWidth, content.maxWidth);
      contentHeight = clamp(measured.height, content.minHeight, content.maxHeight);
    } else {
      const measured = node.measureContent(content);
      contentWidth = clamp(measured.width, content.minWidth, content.maxWidth);
      contentHeight = clamp(measured.height, content.minHeight, content.maxHeight);
    }

    const horizontal = params.padding.left + params.padding.right;
    const vertical = params.padding.top + params.padding.bottom;
    let width = fixedWidth ?? contentWidth + horizontal;
    let height = fixedHeight ?? contentHeight + vertical;

    if (params.aspectRatio) {
      if (fixedWidth !== null && fixedHeight === null) {
        height = width / params.aspectRatio;
      } else if (fixedHeight !== null && fixedWidth === null) {
        width = height * params.aspectRatio;
      }
    }

    const result: Size = {
      width: clamp(width, own.minWidth, own.maxWidth),
      height: clamp(height, own.minHeight, own.maxHeight),
    };

    if (cache.size >= MAX_CACHE_ENTRIES_PER_NODE) {
      cache.clear();
    }
    cache.set(key, { revision: node.revision, size: result });

    return result;
  }

  measureChildOf(ctx: EngineContext, child: LayoutChild, constraint: BoxConstraints): Size {
    const params = child.params;
    const base = ctx.contentSize;
    const margin = params.margin;
    const horizontal = margin.left + margin.right;
    const vertical = margin.top + margin.bottom;

    const available: BoxConstraints = {
      minWidth: Math.max(0, constraint.minWidth - horizontal),
      maxWidth: Math.max(0, constraint.maxWidth - horizontal),
      minHeight: Math.max(0, constraint.minHeight - vertical),
      maxHeight: Math.max(0, constraint.maxHeight - vertical),
    };

    const fixedWidth = resolveOwnLength(
      params.width,
      params.widthMin,
      params.widthMax,
      base.width,
      params.minWidth,
      params.maxWidth,
    );
    const fixedHeight = resolveOwnLength(
      params.height,
      params.heightMin,
      params.heightMax,
      base.height,
      params.minHeight,
      params.maxHeight,
    );

    const childConstraint: BoxConstraints = {
      minWidth: fixedWidth ?? Math.max(available.minWidth, params.minWidth),
      maxWidth: fixedWidth ?? Math.min(available.maxWidth, params.maxWidth),
      minHeight: fixedHeight ?? Math.max(available.minHeight, params.minHeight),
      maxHeight: fixedHeight ?? Math.min(available.maxHeight, params.maxHeight),
    };
    enforce(childConstraint);

    const measured = this.measureNode(child.node, childConstraint, base);
    child.measured.width = measured.width + horizontal;
    child.measured.height = measured.height + vertical;
    return child.measured;
  }

  resolveOuterSizeOf(ctx: EngineContext, child: LayoutChild): Size {
    const params = child.params;
    const base = ctx.contentSize;
    const margin = params.margin;
    const fixedWidth = resolveOwnLength(
      params.width,
      params.widthMin,
      params.widthMax,
      base.width,
      params.minWidth,
      params.maxWidth,
    );
    const fixedHeight = resolveOwnLength(
      params.height,
      params.heightMin,
      params.heightMax,
      base.height,
      params.minHeight,
      params.maxHeight,
    );

    return {
      width:
        (fixedWidth ?? child.measured.width - margin.left - margin.right) +
        margin.left +
        margin.right,
      height:
        (fixedHeight ?? child.measured.height - margin.top - margin.bottom) +
        margin.top +
        margin.bottom,
    };
  }

  private measureContainer(container: ContainerLayout, ctx: EngineContext): Size {
    switch (container.type) {
      case 'box':
        return measureBox(ctx, container.options);
      case 'grid':
        return measureGrid(ctx, container.options);
      case 'stack':
        return measureStack(ctx, container.options);
      case 'scroll':
        return measureScroll(ctx, container.options);
      case 'absolute':
        return measureAbsolute(ctx);
      default:
        return ZERO_SIZE;
    }
  }

  // ---------------------------------------------------------------- arrange pass

  private arrangeRoot(root: LayoutNode, rect: Rect): void {
    this.arrangeNode(root, this.snap(rect));
  }

  private arrangeNode(node: LayoutNode, rect: Rect): void {
    // `rect` is in the *parent's* local coordinates: that is what the renderer object stores.
    node.applyRect(rect);
    this.stats.arrangeCalls++;

    if (!node.container || node.children.length === 0) {
      return;
    }

    // Children are arranged in *this node's* local coordinate space, whose origin is the node's
    // own top-left corner (containers position their children relatively). Only the sizes come from
    // `rect`; the offsets come from this node's padding. Mixing the two would accumulate the
    // parent's offset at every nesting level.
    const params = node.layoutParams;
    const padding = params.padding;
    const ctx = this.acquireContext(node, ZERO_RECT, unbounded(), { width: 0, height: 0 }, false);
    ctx.rect.x = padding.left;
    ctx.rect.y = padding.top;
    ctx.rect.width = Math.max(0, rect.width - padding.left - padding.right);
    ctx.rect.height = Math.max(0, rect.height - padding.top - padding.bottom);
    ctx.constraint = {
      minWidth: 0,
      maxWidth: ctx.rect.width,
      minHeight: 0,
      maxHeight: ctx.rect.height,
    };
    ctx.contentSize.width = ctx.rect.width;
    ctx.contentSize.height = ctx.rect.height;

    this.arrangeContainer(node.container, ctx);
    this.releaseContext(ctx);
  }

  placeChildOf(_ctx: EngineContext, child: LayoutChild, rect: Rect): void {
    copyRect(child.rect, rect);
    this.stats.placedChildren++;

    const target = this.snap(rect);
    const applied = this.appliedRects.get(child.node);
    const stale =
      this.activeDirty.has(child.node) ||
      this.activeDirtyPath.has(child.node) ||
      this.dirty.has(child.node) ||
      this.dirtyPath.has(child.node);
    if (
      applied &&
      applied.generation === this.generation &&
      !stale &&
      rectEquals(applied, target)
    ) {
      this.stats.skippedSubtrees++;
      return;
    }

    if (applied) {
      copyRect(applied, target);
      applied.generation = this.generation;
    } else {
      this.appliedRects.set(child.node, {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        generation: this.generation,
      });
    }

    const tight: BoxConstraints = {
      minWidth: target.width,
      maxWidth: target.width,
      minHeight: target.height,
      maxHeight: target.height,
    };
    this.measureNode(child.node, tight, { width: target.width, height: target.height });
    this.arrangeNode(child.node, target);
  }

  private arrangeContainer(container: ContainerLayout, ctx: EngineContext): void {
    switch (container.type) {
      case 'box':
        arrangeBox(ctx, container.options);
        arrangeAbsolute(ctx);
        break;
      case 'grid':
        arrangeGrid(ctx, container.options);
        arrangeAbsolute(ctx);
        break;
      case 'stack':
        arrangeStack(ctx, container.options);
        arrangeAbsolute(ctx);
        break;
      case 'scroll':
        arrangeScroll(ctx, container.options);
        arrangeAbsolute(ctx);
        break;
      case 'absolute':
        arrangeAbsolute(ctx);
        break;
      default:
        break;
    }
  }

  /** Snaps a rect in place to the device pixel grid (layout stays sub-pixel until here). */
  private snap(rect: Rect): Rect {
    if (this.snapMode === 'none') {
      return rect;
    }
    this.stats.snappedRects++;
    return snapRect(rect, this.dpr, this.snapMode);
  }

  // ---------------------------------------------------------------- plumbing

  private cacheFor(node: LayoutNode): Map<string, CacheEntry> {
    let cache = this.caches.get(node);
    if (!cache) {
      cache = new Map();
      this.caches.set(node, cache);
    }
    return cache;
  }

  private acquireContext(
    node: LayoutNode,
    rect: Rect,
    constraint: BoxConstraints,
    contentSize: Size,
    measuring: boolean,
  ): EngineContext {
    let ctx = this.contextPool[this.contextDepth];
    if (!ctx) {
      ctx = new EngineContext(this);
      this.contextPool[this.contextDepth] = ctx;
    }
    this.contextDepth++;

    ctx.node = node;
    ctx.measuring = measuring;
    ctx.constraint = constraint;
    ctx.contentSize.width = contentSize.width;
    ctx.contentSize.height = contentSize.height;

    // The arrange rect is mutated in place (padding is deflated out of it), so reset it here.
    ctx.rect.x = rect.x;
    ctx.rect.y = rect.y;
    ctx.rect.width = rect.width;
    ctx.rect.height = rect.height;

    const children = node.children;
    let records = this.records.get(node);
    if (!records || records.length !== children.length) {
      records = new Array<ChildRecord>(children.length);
      for (let i = 0; i < children.length; i++) {
        records[i] = new ChildRecord();
      }
      this.records.set(node, records);
    }
    ctx.children = records;
    for (let i = 0; i < children.length; i++) {
      (records[i] as ChildRecord).reset(children[i] as LayoutNode, i, measuring);
    }

    return ctx;
  }

  /**
   * Returns a measured/arranged container's context to the pool.
   *
   * The pool is indexed by depth, so the slot is reused by the next container at the same nesting
   * level; the strong references to the node and its child records are dropped here. Keeping them made
   * the pool a grow-only list that pinned every node of the last pass for the lifetime of the engine,
   * which is exactly what the `WeakMap`s used for caches and rects are there to prevent.
   */
  private releaseContext(ctx: EngineContext): void {
    if (this.contextDepth > 0) {
      this.contextDepth--;
    }
    ctx.node = null;
    ctx.children = [];
  }
}

function resolveOwnLength(
  unit: LengthUnit,
  lengthMin: number,
  lengthMax: number,
  base: number,
  paramMin: number,
  paramMax: number,
): number | null {
  const resolved = resolveLength(unit, base);
  if (resolved === null || !Number.isFinite(resolved)) {
    return null;
  }
  const min = Math.max(lengthMin, paramMin);
  const max = Math.min(lengthMax, paramMax);
  return clamp(resolved, min, max);
}

/** Cache key: the node's own constraint plus the containing block its percentages resolve against. */
function cacheKeyOf(own: BoxConstraints, base: Size): string {
  return `${constraintsKey(own)}|${base.width}x${base.height}`;
}

function percentBaseOf(constraint: BoxConstraints): Size {
  return {
    width: Number.isFinite(constraint.maxWidth) ? constraint.maxWidth : Infinity,
    height: Number.isFinite(constraint.maxHeight) ? constraint.maxHeight : Infinity,
  };
}

/**
 * The base `fill` and percentage lengths resolve against for a container's children.
 *
 * Normally that is the container's own content box. When an axis of that box is unbounded — which is
 * exactly what a scroll port hands its content, so it can grow past the viewport — the axis falls
 * back to the containing block the container itself was measured in. Without the fallback a
 * `height: 'fill'` child of a scroll port would resolve against `Infinity`, collapse to its content
 * and lose the viewport height it is explicitly asking for (a virtualised list inside a `ScrollView`
 * is the case that matters).
 */
function contentBaseOf(content: BoxConstraints, base: Size): Size {
  return {
    width: Number.isFinite(content.maxWidth) ? content.maxWidth : base.width,
    height: Number.isFinite(content.maxHeight) ? content.maxHeight : base.height,
  };
}

/**
 * Containers whose flow arranger ignores `position: 'absolute'` children.
 *
 * Only those need the engine's extra measuring pass over the absolute children (see `measureNode`).
 * `absolute` handles them itself, and `scroll` measures every child because it is the one place where
 * "how long is the content" has to survive the port's own size limit.
 */
function skipsAbsoluteChildren(container: ContainerLayout): boolean {
  return container.type === 'box' || container.type === 'grid' || container.type === 'stack';
}

/** Convenience for tests and adapters: lays out a single node and returns its size. */
export function measureNodeOnce(
  engine: LayoutEngine,
  node: LayoutNode,
  constraint: BoxConstraints,
): Size {
  return engine.layout(node, constraint);
}
