/**
 * Stack and absolute arrangers.
 *
 * `stack` layers flow children on top of each other inside the content box (dialogs, badges,
 * overlays); `absolute` positions the children that opted out of the flow via
 * `position: 'absolute'` and `left/top/right/bottom` offsets (CSS-like semantics).
 *
 * Contract notes shared with `box`/`grid`:
 * - `ctx.rect` is the parent's content box, in parent-local coordinates.
 * - `ctx.measureChild(child, constraint)` returns the child's outer (margin-box) size.
 * - `ctx.placeChild(child, rect)` takes the child's **border box**, margins already applied.
 * - Children with `params.position === 'absolute'` are skipped by the flow arrangers.
 */

import type { Size } from './geom';
import { alignOffset, borderSize, resolveOffset } from './internal';
import type { Align } from './params';
import type { ArrangerContext, StackLayoutOptions } from './types';

type AlignKeyword = Exclude<Align, 'auto' | 'stretch'>;

export function measureStack(ctx: ArrangerContext, _options?: StackLayoutOptions): Size {
  let width = 0;
  let height = 0;
  // Stacked children are aligned, not stretched, so they are measured at-most: the engine hands
  // containers a loosened constraint, so a tight parent (a full-screen `UIRoot`, say) cannot force
  // every stacked child to fill it.
  for (const child of ctx.children) {
    if (child.params.position === 'absolute' || !child.node.inFlow) {
      continue;
    }
    const measured = ctx.measureChild(child, ctx.constraint);
    width = Math.max(width, measured.width);
    height = Math.max(height, measured.height);
  }
  return { width, height };
}

export function arrangeStack(ctx: ArrangerContext, options?: StackLayoutOptions): void {
  const align: AlignKeyword = options?.align ?? 'center';
  const content = ctx.rect;

  for (const child of ctx.children) {
    if (child.params.position === 'absolute' || !child.node.inFlow) {
      continue;
    }
    const outer = ctx.resolveOuterSize(child);
    const margin = child.params.margin;
    const size = borderSize(outer, margin);
    const x = alignOffset(content.x, content.width, size.width, align);
    const y = alignOffset(content.y, content.height, size.height, align);
    ctx.placeChild(child, {
      x: x + margin.left,
      y: y + margin.top,
      width: size.width,
      height: size.height,
    });
  }
}

/** An absolute container's auto size wraps all of its children. */
export function measureAbsolute(ctx: ArrangerContext): Size {
  let width = 0;
  let height = 0;
  for (const child of ctx.children) {
    if (!child.node.inFlow) {
      continue;
    }
    const measured = ctx.measureChild(child, ctx.constraint);
    width = Math.max(width, measured.width);
    height = Math.max(height, measured.height);
  }
  return { width, height };
}

export function arrangeAbsolute(ctx: ArrangerContext): void {
  const content = ctx.rect;
  const base = ctx.contentSize;

  for (const child of ctx.children) {
    const params = child.params;
    if (params.position !== 'absolute' || !child.node.inFlow) {
      continue;
    }

    const outer = ctx.resolveOuterSize(child);
    const margin = params.margin;
    const size = borderSize(outer, margin);

    const left = resolveOffset(params.left, base.width);
    const right = resolveOffset(params.right, base.width);
    const top = resolveOffset(params.top, base.height);
    const bottom = resolveOffset(params.bottom, base.height);

    let x = content.x;
    if (left !== null) {
      x = content.x + left;
    } else if (right !== null) {
      x = content.x + content.width - right - size.width;
    }

    let y = content.y;
    if (top !== null) {
      y = content.y + top;
    } else if (bottom !== null) {
      y = content.y + content.height - bottom - size.height;
    }

    ctx.placeChild(child, {
      x: x + margin.left,
      y: y + margin.top,
      width: size.width,
      height: size.height,
    });
  }
}
