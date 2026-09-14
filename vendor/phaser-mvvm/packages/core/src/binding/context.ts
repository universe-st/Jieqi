/**
 * `BindingContext` — the scope chain a template/binding resolves paths against (PLAN §4.4).
 *
 * A context carries the data root (`vm`) plus the scope variables of the current level:
 *
 * | variable  | resolves to                                                        |
 * |-----------|--------------------------------------------------------------------|
 * | `$root`   | the top-most context of the chain (its `vm` for un-prefixed paths) |
 * | `$parent` | the enclosing context, or `null` at the root                       |
 * | `$item`   | the item of the current list level                                 |
 * | `$index`  | the index of the current list level (`0` at the root)              |
 *
 * Un-prefixed paths (`user.name`) resolve against `vm`, the plain object the expression compiler
 * reads. `child()` derives a nested level, which is what `Repeat` does per row: the row context
 * keeps `$root`/`$parent` reachable while pointing its own paths at the row item.
 */

import type { CompiledPath, PathScope } from './expression';
import { compilePath } from './expression';

/**
 * Builds the scope object of a level.
 *
 * The default node is a plain object holding the level's values; a factory can return a different
 * node — or redefine individual properties of the default one — which is how a list scope keeps
 * `$item`/`$index` *live*: the property is read on every access, so a binding that reads it collects
 * the dependency and re-renders when the row is reused with a new index (see `Repeat`).
 */
export type ScopeNodeFactory = (base: PathScope) => PathScope;

/** Options accepted by the `BindingContext` constructor. */
export interface BindingContextOptions {
  /** Enclosing context; `$parent` points at it. */
  parent?: BindingContext | null;
  /** Data root for un-prefixed paths. Defaults to the parent's `vm`. */
  vm?: unknown;
  /** Value of `$item` at this level. */
  item?: unknown;
  /** Value of `$index` at this level. Defaults to `0`. */
  index?: number;
  /** Overrides how this level's scope object is built. */
  scopeNode?: ScopeNodeFactory;
}

/** Variables a child scope can override. */
export interface ChildScopeVars {
  /** Value of `$item` in the child scope. */
  item?: unknown;
  /** Value of `$index` in the child scope. */
  index?: number;
  /** Data root of the child scope; defaults to the parent's `vm`. */
  vm?: unknown;
  /** Overrides how the child's scope object is built. */
  scopeNode?: ScopeNodeFactory;
}

/** Anything a binding can read paths from: a `BindingContext` or a raw scope object. */
export type BindingSource = BindingContext | PathScope;

/** `true` for a `BindingContext` (duck-typed, so the adapter needs no `instanceof`). */
export function isBindingContext(value: unknown): value is BindingContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BindingContext).resolve === 'function' &&
    typeof (value as BindingContext).child === 'function'
  );
}

export class BindingContext {
  /** Data root un-prefixed paths resolve against. */
  readonly vm: unknown;
  /** Enclosing scope, or `null` at the root. */
  readonly parent: BindingContext | null;
  /** Current list item. */
  readonly item: unknown;
  /** Index of the current list level. */
  readonly index: number;

  private node: PathScope | null = null;
  private readonly buildScopeNode: ScopeNodeFactory | undefined;
  private readonly compiled = new Map<string, CompiledPath>();

  constructor(vm: unknown, options: BindingContextOptions = {}) {
    this.parent = options.parent ?? null;
    this.vm = options.vm !== undefined ? options.vm : vm;
    this.item = options.item;
    this.index = options.index ?? 0;
    this.buildScopeNode = options.scopeNode;
  }

  /** The top-most context of the chain. */
  get $root(): BindingContext {
    return this.parent === null ? this : this.parent.$root;
  }

  /** The enclosing context (`null` at the root). */
  get $parent(): BindingContext | null {
    return this.parent;
  }

  /** Item of the current list level. */
  get $item(): unknown {
    return this.item;
  }

  /** Index of the current list level. */
  get $index(): number {
    return this.index;
  }

  /**
   * The plain scope object the expression compiler walks. Built once and shared with the child
   * scopes, so a compiled path never has to rebuild the chain.
   */
  get scopeNode(): PathScope {
    if (this.node === null) {
      const node: PathScope = {
        $vm: this.vm,
        $root: null,
        $parent: null,
        $item: this.item,
        $index: this.index,
      };
      if (this.parent === null) {
        node.$root = node;
      } else {
        const parentNode = this.parent.scopeNode;
        node.$parent = parentNode;
        node.$root = parentNode.$root ?? parentNode;
      }
      this.node = this.buildScopeNode ? this.buildScopeNode(node) : node;
    }
    return this.node;
  }

  /** Compiles (and caches) a path expression for this context's chain. */
  compile(path: string): CompiledPath {
    let compiled = this.compiled.get(path);
    if (compiled === undefined) {
      compiled = compilePath(path);
      this.compiled.set(path, compiled);
    }
    return compiled;
  }

  /** Reads a path (or a pre-compiled one) against this scope. */
  resolve(path: string | CompiledPath): unknown {
    const compiled = typeof path === 'string' ? this.compile(path) : path;
    return compiled.get(this.scopeNode);
  }

  /** Writes the last segment of a path; `false` when there is nothing writable to target. */
  set(path: string | CompiledPath, value: unknown): boolean {
    const compiled = typeof path === 'string' ? this.compile(path) : path;
    return compiled.set(this.scopeNode, value);
  }

  /** Derives a nested scope (a list row, a nested template) from this one. */
  child(scopeVars: ChildScopeVars = {}): BindingContext {
    return new BindingContext(scopeVars.vm !== undefined ? scopeVars.vm : this.vm, {
      parent: this,
      item: scopeVars.item,
      index: scopeVars.index,
      scopeNode: scopeVars.scopeNode,
    });
  }
}
