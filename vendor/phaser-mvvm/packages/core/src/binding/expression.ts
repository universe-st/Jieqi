/**
 * Path expression compiler (PLAN §4.4).
 *
 * `a.b[0].c` / `items[1].name` / `$item.title` are parsed into a segment list and closed over by a
 * pair of accessor closures. Deliberately **no `eval`, no `new Function`**: the compiler is a plain
 * recursive-descent scanner, so it works under a strict CSP (`script-src` without `unsafe-eval`) and
 * is fully unit-testable in Node.
 *
 * The scope a compiled path reads from is a `PathScope`: a plain object that carries the scope
 * variables (`$vm`, `$root`, `$parent`, `$item`, `$index`) next to the visible data. That keeps the
 * compiler independent of `BindingContext` (see `context.ts`), which simply builds such objects.
 */

/** Marks the object a `PathScope`'s un-prefixed paths start from. */
export const SCOPE_VM = '$vm';

/** A scope object: data root plus the scope variables a template can address. */
export interface PathScope {
  /** Data object that un-prefixed paths resolve against; the scope object itself when absent. */
  [SCOPE_VM]?: unknown;
  /** Top of the scope chain (`$root`); defaults to the scope itself. */
  $root?: unknown;
  /** Enclosing scope (`$parent`), or `null` at the root. */
  $parent?: unknown;
  /** Current list item (`$item`). */
  $item?: unknown;
  /** Index of the current item (`$index`); defaults to `0`. */
  $index?: number;
  [key: string]: unknown;
}

/** A compiled path expression. */
export interface CompiledPath {
  /** The source text, trimmed. */
  readonly source: string;
  /**
   * Normalised segments in reading order: property names as written, bracket indices as digit
   * strings (`'a.b[0].c'` → `['a', 'b', '0', 'c']`).
   */
  readonly segments: string[];
  /** Reads the path; a missing link yields `undefined` instead of throwing. */
  get(scope: PathScope): unknown;
  /** Writes the last segment; returns `false` when there is nothing to write into. */
  set(scope: PathScope, value: unknown): boolean;
}

/** Scope variables an expression can start with. */
const SCOPE_VARIABLES = new Set(['$root', '$parent', '$item', '$index']);

/** Raised for a malformed path expression; carries the offending offset. */
export class PathSyntaxError extends Error {
  /** The expression that failed to parse. */
  readonly source: string;
  /** Zero-based offset of the offending character. */
  readonly position: number;

  constructor(source: string, position: number, detail: string) {
    super(`Invalid path expression "${source}" at position ${position}: ${detail}`);
    this.name = 'PathSyntaxError';
    this.source = source;
    this.position = position;
  }
}

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';

const isIdentStart = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z_$]/.test(char);

const isIdentPart = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$]/.test(char);

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= '0' && char <= '9';

/** Splits a path expression into its segments; throws `PathSyntaxError` on malformed input. */
export function parsePath(source: string): string[] {
  if (typeof source !== 'string') {
    throw new TypeError('parsePath() expects a string');
  }

  const text = source.trim();
  const segments: string[] = [];
  let index = 0;

  if (text.length === 0) {
    throw new PathSyntaxError(source, 0, 'the expression is empty');
  }

  for (;;) {
    if (isIdentStart(text[index])) {
      const start = index;
      while (isIdentPart(text[index])) index++;
      segments.push(text.slice(start, index));
    } else if (text[index] === '[') {
      if (segments.length === 0) {
        throw new PathSyntaxError(source, index, 'a path must start with a property name');
      }
      segments.push(parseBracket(source, text, index + 1, (next) => (index = next)));
    } else {
      const char = text[index];
      throw new PathSyntaxError(
        source,
        index,
        char === undefined
          ? 'unexpected end of expression'
          : `unexpected "${char}", expected a property name`,
      );
    }

    while (isSpace(text[index])) index++;
    if (index >= text.length) break;
    if (text[index] === '.') {
      index++;
      while (isSpace(text[index])) index++;
      if (index >= text.length) {
        throw new PathSyntaxError(source, index, 'the expression ends with "."');
      }
      continue;
    }
    if (text[index] === '[') {
      continue;
    }
    throw new PathSyntaxError(source, index, `unexpected "${text[index]}", expected "." or "["`);
  }

  return segments;
}

/** Parses `[0]` / `['key']` / `["key"]` and returns the segment text. */
function parseBracket(
  source: string,
  text: string,
  start: number,
  commit: (next: number) => void,
): string {
  let index = start;
  while (isSpace(text[index])) index++;

  let value: string;
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    index++;
    let buffer = '';
    let closed = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\' && index + 1 < text.length) {
        buffer += text[index + 1];
        index += 2;
        continue;
      }
      if (char === quote) {
        closed = true;
        index++;
        break;
      }
      buffer += char;
      index++;
    }
    if (!closed) {
      throw new PathSyntaxError(source, start, 'unterminated string key');
    }
    value = buffer;
  } else {
    const digits = index;
    while (isDigit(text[index])) index++;
    if (index === digits) {
      throw new PathSyntaxError(source, index, 'expected a numeric index or a quoted key');
    }
    value = text.slice(digits, index);
  }

  while (isSpace(text[index])) index++;
  if (text[index] !== ']') {
    throw new PathSyntaxError(source, index, 'expected "]"');
  }
  commit(index + 1);
  return value;
}

/** `true` for a scope object built by `BindingContext` (or an equivalent hand-made scope). */
export function isPathScope(value: unknown): value is PathScope {
  return typeof value === 'object' && value !== null && SCOPE_VM in value;
}

/** The data a path resolves against inside `node`. */
function dataOf(node: unknown): unknown {
  return isPathScope(node) ? node[SCOPE_VM] : node;
}

function readProperty(container: unknown, segment: string): unknown {
  if (container === null || container === undefined) {
    return undefined;
  }
  if (
    typeof container !== 'object' &&
    typeof container !== 'function' &&
    typeof container !== 'string'
  ) {
    return undefined;
  }
  return (container as Record<string, unknown>)[segment];
}

function canWrite(container: unknown): container is Record<string, unknown> {
  return (
    container !== null &&
    container !== undefined &&
    (typeof container === 'object' || typeof container === 'function')
  );
}

/**
 * Compiles a path expression into accessor closures.
 *
 * Resolution rules, applied to the first segment and to `$`-prefixed segments anywhere:
 * - `$root` → the root scope (defaults to the scope itself), `$parent` → the enclosing scope,
 * - `$item` / `$index` → the scope's list variables (`$index` defaults to `0`),
 * - anything else → a property/index read on the current data object.
 */
export function compilePath(source: string): CompiledPath {
  const segments = parsePath(source);
  const sourceText = source.trim();

  /** Walks every segment but the last and returns the container the last one belongs to. */
  const walk = (scope: PathScope, keep: number): unknown => {
    let node: unknown = scope;
    let value: unknown = dataOf(scope);
    let nodeLive = true;

    for (let i = 0; i < keep; i++) {
      const segment = segments[i] as string;
      if (nodeLive && SCOPE_VARIABLES.has(segment)) {
        const scopeNode = node as PathScope;
        if (segment === '$root') {
          const root = scopeNode.$root;
          node = root === undefined || root === null ? scopeNode : root;
          value = dataOf(node);
        } else if (segment === '$parent') {
          const parent = scopeNode.$parent;
          node = parent === undefined || parent === null ? null : parent;
          nodeLive = node !== null;
          value = dataOf(node);
        } else if (segment === '$item') {
          value = scopeNode.$item;
          nodeLive = false;
        } else {
          value = scopeNode.$index ?? 0;
          nodeLive = false;
        }
        continue;
      }
      value = readProperty(value, segment);
      node = value;
      nodeLive = false;
    }

    return value;
  };

  return {
    source: sourceText,
    segments,
    get(scope: PathScope): unknown {
      return walk(scope, segments.length);
    },
    set(scope: PathScope, value: unknown): boolean {
      const last = segments[segments.length - 1];
      if (last === undefined || SCOPE_VARIABLES.has(last)) {
        return false;
      }
      const container = walk(scope, segments.length - 1);
      if (!canWrite(container)) {
        return false;
      }
      container[last] = value;
      return true;
    },
  };
}
