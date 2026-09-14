/**
 * Value converters ("filters") of the binding layer (PLAN §4.4, `convert` row).
 *
 * A converter is a plain `(value, ...args) => result` function registered under a name and applied
 * either from a template (`{{ price | money('$', 2) }}`) or from code
 * (`applyConverter('money', 12, '$', 2)`). The registry is process-global and deliberately tiny:
 * converters are presentation helpers, not a pipeline engine.
 */

/** A conversion function. Extra arguments come from the template call site. */
export type Converter = (value: unknown, ...args: unknown[]) => unknown;

const converters = new Map<string, Converter>();

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(toText).join(', ');
  }
  return String(value);
}

/** Coerces a converter argument to a number; non-numeric input keeps its first argument. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value === null || value === undefined || value === '') {
    return Number.NaN;
  }
  return Number(toText(value).trim());
}

/** Reads the optional decimals argument, clamped to a sane integer range. */
function decimalsOf(value: unknown, fallback: number): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(20, Math.trunc(parsed)));
}

/** `true` for a value the `default` converter treats as absent. */
function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (typeof value === 'number' && Number.isNaN(value))
  );
}

const DATE_TOKENS: ReadonlyArray<readonly [string, (date: Date) => string]> = [
  ['YYYY', (date) => String(date.getFullYear()).padStart(4, '0')],
  ['YY', (date) => String(date.getFullYear() % 100).padStart(2, '0')],
  ['MM', (date) => String(date.getMonth() + 1).padStart(2, '0')],
  ['DD', (date) => String(date.getDate()).padStart(2, '0')],
  ['HH', (date) => String(date.getHours()).padStart(2, '0')],
  ['mm', (date) => String(date.getMinutes()).padStart(2, '0')],
  ['ss', (date) => String(date.getSeconds()).padStart(2, '0')],
];

/** Coerces a value into a `Date`, accepting `Date`, epoch milliseconds and date strings. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const fromString = new Date(value);
    return Number.isNaN(fromString.getTime()) ? null : fromString;
  }
  return null;
}

/** Names registered by `installBuiltInConverters()` (in registration order). */
export const BUILT_IN_CONVERTERS = [
  'upper',
  'lower',
  'trim',
  'number',
  'money',
  'join',
  'default',
  'date',
] as const;

/**
 * Normalises a converter name.
 *
 * Registration trimmed the name while the lookups did not, so `registerConverter(' money ', fn)` made
 * a converter that `hasConverter(' money ')` denied and `applyConverter(' money ', …)` could not find.
 * Every entry point now agrees on the trimmed form.
 */
function converterKey(name: string): string {
  return name.trim();
}

/** Registers (or replaces) a converter. */
export function registerConverter(name: string, fn: Converter): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('registerConverter() expects a non-empty name');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`registerConverter("${name}") expects a function`);
  }
  converters.set(converterKey(name), fn);
}

/** Removes a converter; returns `true` when one was registered under that name. */
export function unregisterConverter(name: string): boolean {
  return converters.delete(converterKey(name));
}

/** `true` when a converter is registered under `name`. */
export function hasConverter(name: string): boolean {
  return converters.has(converterKey(name));
}

/** Registered converter names, in registration order. */
export function converterNames(): string[] {
  return Array.from(converters.keys());
}

/** Applies a converter by name; throws for an unknown name (a typo must not fail silently). */
export function applyConverter(name: string, value: unknown, ...args: unknown[]): unknown {
  const converter = converters.get(converterKey(name));
  if (converter === undefined) {
    throw new Error(
      `Unknown converter "${name.trim()}". Registered converters: ${
        converterNames().join(', ') || '(none)'
      }`,
    );
  }
  return converter(value, ...args);
}

/** Restores the built-in set, dropping anything registered by the application (tests, hot reload). */
export function resetConverters(): void {
  converters.clear();
  installBuiltInConverters();
}

/** Registers the built-in converters; called once at module load and by `resetConverters()`. */
export function installBuiltInConverters(): void {
  registerConverter('upper', (value) => toText(value).toUpperCase());
  registerConverter('lower', (value) => toText(value).toLowerCase());
  registerConverter('trim', (value) => toText(value).trim());

  registerConverter('number', (value, decimals) => {
    const parsed = toNumber(value);
    if (!Number.isFinite(parsed)) {
      // Nothing sensible to render: an unparseable value formats as empty.
      return '';
    }
    if (decimals === undefined) {
      return parsed;
    }
    return parsed.toFixed(decimalsOf(decimals, 0));
  });

  registerConverter('money', (value, symbol, decimals) => {
    const parsed = toNumber(value);
    const places = decimalsOf(decimals, 2);
    const amount = Number.isFinite(parsed) ? parsed : 0;
    return `${symbol === undefined || symbol === null ? '$' : toText(symbol)}${amount.toFixed(places)}`;
  });

  registerConverter('join', (value, separator) => {
    const glue = separator === undefined ? ', ' : toText(separator);
    if (Array.isArray(value)) {
      return value.map(toText).join(glue);
    }
    return toText(value);
  });

  registerConverter('default', (value, fallback) => (isEmpty(value) ? fallback : value));

  registerConverter('date', (value, pattern) => {
    const date = toDate(value);
    if (date === null) {
      return '';
    }
    const template = pattern === undefined || pattern === null ? 'YYYY-MM-DD' : toText(pattern);
    let out = '';
    let index = 0;
    while (index < template.length) {
      const token = DATE_TOKENS.find((entry) => template.startsWith(entry[0], index));
      if (token !== undefined) {
        out += token[1](date);
        index += token[0].length;
        continue;
      }
      out += template[index];
      index++;
    }
    return out;
  });
}

installBuiltInConverters();
