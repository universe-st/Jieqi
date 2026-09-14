/**
 * Interpolation templates: `parseInterpolation` / `formatTemplate` (PLAN §4.4, `convert` row).
 *
 * A template is a string with `{{ path | converter(arg, ...) }}` holes:
 *
 * ```ts
 * const segments = parseInterpolation('共 {{ items.length }} 项');
 * formatTemplate(context, segments); // => '共 3 项'
 * ```
 *
 * Both halves are pure functions of their arguments — no reactive reading happens here — which is
 * what makes them directly testable. `formatTemplate` only needs an object exposing `resolve(path)`
 * (a `BindingContext` satisfies it), so a test can pass a plain lookup function instead.
 *
 * Escapes: `\{{`, `\}}` and `\\` produce the literal characters, so a template can show a brace
 * without opening a hole. Every other backslash is left untouched (Windows paths stay readable).
 */

import type { PathScope } from './expression';
import { PathSyntaxError, compilePath } from './expression';
import { applyConverter } from './converter';

/** A literal chunk of a template. */
export interface TextSegment {
  type: 'text';
  value: string;
}

/** One `name(arg, ...)` call inside a hole. */
export interface TemplateConverter {
  /** Converter name, as written. */
  name: string;
  /** Literal arguments, already parsed into JS values. */
  args: unknown[];
}

/** A `{{ … }}` hole. */
export interface ExpressionSegment {
  type: 'expression';
  /** The path part, trimmed: `items.length`. */
  path: string;
  /** The whole hole body, trimmed: `items.length | number(2)`. */
  source: string;
  /** Converters applied left to right after the path was read. */
  converters: TemplateConverter[];
}

export type TemplateSegment = TextSegment | ExpressionSegment;

/** Anything `formatTemplate` can read paths from. `BindingContext` and plain objects both fit. */
export interface TemplateScope {
  resolve(path: string): unknown;
}

/** A scope or a bare resolver function (handy in tests). */
export type TemplateSource = TemplateScope | ((path: string) => unknown);

/** Raised for a malformed template; carries the offending offset. */
export class TemplateSyntaxError extends Error {
  readonly source: string;
  readonly position: number;

  constructor(source: string, position: number, detail: string) {
    super(`Invalid template "${source}" at position ${position}: ${detail}`);
    this.name = 'TemplateSyntaxError';
    this.source = source;
    this.position = position;
  }
}

const OPEN = '{{';
const CLOSE = '}}';

/** Parses a template into text and expression segments. */
export function parseInterpolation(source: string): TemplateSegment[] {
  if (typeof source !== 'string') {
    throw new TypeError('parseInterpolation() expects a string');
  }

  const segments: TemplateSegment[] = [];
  let text = '';
  let index = 0;

  const flushText = (): void => {
    if (text.length > 0) {
      segments.push({ type: 'text', value: text });
      text = '';
    }
  };

  while (index < source.length) {
    const char = source[index] as string;

    if (
      char === '\\' &&
      (source.startsWith(OPEN, index + 1) ||
        source.startsWith(CLOSE, index + 1) ||
        source[index + 1] === '\\')
    ) {
      const escaped = source.startsWith(OPEN, index + 1)
        ? OPEN
        : source.startsWith(CLOSE, index + 1)
          ? CLOSE
          : '\\';
      text += escaped;
      index += 1 + escaped.length;
      continue;
    }

    if (source.startsWith(OPEN, index)) {
      const close = source.indexOf(CLOSE, index + OPEN.length);
      if (close === -1) {
        throw new TemplateSyntaxError(source, index, 'unterminated "{{"');
      }
      flushText();
      const body = source.slice(index + OPEN.length, close);
      segments.push(parseExpression(source, index + OPEN.length, body));
      index = close + CLOSE.length;
      continue;
    }

    text += char;
    index++;
  }

  flushText();
  return segments;
}

/** Parses the inside of a hole: `path | converter(args) | …`. */
function parseExpression(source: string, offset: number, body: string): ExpressionSegment {
  const parts = splitTopLevel(body, '|');
  const path = (parts[0] ?? '').trim();
  if (path.length === 0) {
    throw new TemplateSyntaxError(source, offset, 'the expression is empty');
  }
  // Validates the path eagerly so a typo is reported at parse time (with the template offset).
  try {
    compilePath(path);
  } catch (error) {
    if (error instanceof PathSyntaxError) {
      throw new TemplateSyntaxError(source, offset + error.position, error.message);
    }
    throw error;
  }

  const converters: TemplateConverter[] = [];
  for (let i = 1; i < parts.length; i++) {
    converters.push(parseConverter(source, offset, parts[i] as string));
  }

  return { type: 'expression', path, source: body.trim(), converters };
}

function parseConverter(source: string, offset: number, raw: string): TemplateConverter {
  const text = raw.trim();
  const open = text.indexOf('(');
  if (open === -1) {
    if (text.length === 0) {
      throw new TemplateSyntaxError(source, offset, 'empty converter name');
    }
    return { name: text, args: [] };
  }
  if (!text.endsWith(')')) {
    throw new TemplateSyntaxError(source, offset, `unterminated converter call "${text}"`);
  }
  const name = text.slice(0, open).trim();
  if (name.length === 0) {
    throw new TemplateSyntaxError(source, offset, 'empty converter name');
  }
  const argsText = text.slice(open + 1, -1);
  const args = argsText.trim().length === 0 ? [] : splitTopLevel(argsText, ',').map(parseLiteral);
  return { name, args };
}

/** Splits on a separator that is outside quotes and parentheses. */
function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;

  for (let index = 0; index < source.length; index++) {
    const char = source[index] as string;
    if (quote !== null) {
      current += char;
      if (char === '\\' && index + 1 < source.length) {
        current += source[index + 1];
        index++;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** The escape sequences a quoted converter argument understands. */
const LITERAL_ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'",
  '\\': '\\',
  n: '\n',
  t: '\t',
};

/** Parses a converter argument: string, number, boolean, null, or a bare word as a string. */
function parseLiteral(source: string): unknown {
  const text = source.trim();
  if (text.length === 0) {
    return '';
  }
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
    // One pass, one lookup: unescaping `\\` first and `\\n` afterwards read a literal backslash-n as an
    // escape sequence a second time, so `{{ p | default('C:\\new') }}` rendered a line break instead of
    // the text the author wrote.
    return text.slice(1, -1).replace(/\\(["'\\nt])/g, (match, escaped: string) => {
      const replacement = LITERAL_ESCAPES[escaped];
      return replacement === undefined ? match : replacement;
    });
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text === 'undefined') return undefined;
  const numeric = Number(text);
  if (text.length > 0 && Number.isFinite(numeric) && /^[+-]?[\d.]/.test(text)) {
    return numeric;
  }
  return text;
}

function resolverOf(source: TemplateSource): (path: string) => unknown {
  if (typeof source === 'function') {
    return source;
  }
  if (source !== null && typeof source === 'object' && typeof source.resolve === 'function') {
    const scope = source;
    return (path) => scope.resolve(path);
  }
  throw new TypeError('formatTemplate() expects a scope with resolve(path) or a resolver function');
}

/** Renders a parsed template against a scope. `null`/`undefined` holes render as empty text. */
export function formatTemplate(
  scope: TemplateSource,
  segments: readonly TemplateSegment[],
): string {
  const resolve = resolverOf(scope);
  let out = '';

  for (const segment of segments) {
    if (segment.type === 'text') {
      out += segment.value;
      continue;
    }
    let value = resolve(segment.path);
    for (const converter of segment.converters) {
      value = applyConverter(converter.name, value, ...converter.args);
    }
    out += stringify(value);
  }

  return out;
}

/** `parseInterpolation` + `formatTemplate` in one call. */
export function interpolate(scope: TemplateSource, source: string): string {
  return formatTemplate(scope, parseInterpolation(source));
}

/** Pre-parses a template once so a binding can re-render it cheaply on every change. */
export function compileTemplate(source: string): {
  source: string;
  segments: TemplateSegment[];
  format(scope: TemplateSource): string;
} {
  const segments = parseInterpolation(source);
  return {
    source,
    segments,
    format: (scope) => formatTemplate(scope, segments),
  };
}

/** Builds a template scope from a plain `PathScope` object (compiling and caching each path). */
export function scopeOfPathScope(scope: PathScope): TemplateScope {
  const cache = new Map<string, ReturnType<typeof compilePath>>();
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

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stringify).join(', ');
  }
  return String(value);
}
