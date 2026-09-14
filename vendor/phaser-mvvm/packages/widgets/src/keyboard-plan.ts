/**
 * The pure half of `VirtualKeyboard`: which keys exist, what they show, and how a press changes the
 * page/case state.
 *
 * The widget (`VirtualKeyboard.ts`) owns the scene objects and the edits on the target field; this module
 * owns the tables and the state machine, so "which character does this key produce on the symbols page
 * after two shift presses" is answerable — and pinnable in a Node test — without a renderer. That split
 * matters because the mapping is 33 slots × 2 pages × 3 case states, which is exactly the kind of table
 * that rots silently.
 *
 * Zero Phaser imports, by construction: this file is part of the widget library's pure core.
 */

/** Which key set to show. */
export type VirtualKeyboardKind = 'text' | 'numeric';

/** Which page the text keyboard is on. A numeric keyboard has exactly one page. */
export type KeyboardPage = 'letters' | 'symbols' | 'numeric';

/** The keys that are not characters. */
export type KeyCommand = 'backspace' | 'enter' | 'space' | 'case' | 'page';

/** One key slot: a stable id (from the letters page), the characters it can show, and its width. */
export interface KeySlot {
  /** Stable id, from the letters page: `q`, `1`, `space`, `shift`, … */
  readonly id: string;
  /** The characters this slot shows, in order: letters page, then the symbols page. */
  readonly chars: readonly string[];
  /** Non-character keys. */
  readonly command?: KeyCommand;
  /** Width in key units (1 = a letter key). */
  readonly weight?: number;
  /** Fixed accessible name, for keys whose glyph says nothing (`⌫` → "Delete"). */
  readonly a11yLabel?: string;
}

/**
 * Shift state, in the shape a phone keyboard has it.
 *
 * One press upper-cases **the next character** and then releases itself; pressing shift twice locks the
 * case until it is pressed a third time. Without the distinction a single tap would look stuck on, and
 * the player would have to press shift again after every capital — the thing every on-screen keyboard
 * solves, and the reason `⇧` and `⇪` are different glyphs.
 */
export interface CaseState {
  readonly upper: boolean;
  /** `true` once shift has been pressed twice: the case survives typing. */
  readonly capsLock: boolean;
}

/** Lower case, no lock. */
export const CASE_OFF: CaseState = { upper: false, capsLock: false };

/** The two character pages, as slots: `chars[0]` is the letters page, `chars[1]` the symbols page. */
const TEXT_SLOTS: readonly KeySlot[] = [
  ...['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].map((letter, i) => ({
    id: letter,
    chars: [letter, '1234567890'[i] ?? letter],
  })),
  ...['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'].map((letter, i) => ({
    id: letter,
    chars: [letter, '@#$%&*()_'[i] ?? letter],
  })),
  ...['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '-'].map((letter, i) => ({
    id: letter,
    chars: [letter, '+=/\\?!,;:'[i] ?? letter],
  })),
];

/** The command row of the text keyboard. */
const TEXT_COMMANDS: readonly KeySlot[] = [
  { id: 'shift', chars: [], command: 'case', a11yLabel: 'Shift' },
  { id: 'page', chars: [], command: 'page', a11yLabel: 'Numbers and symbols' },
  { id: 'space', chars: [], command: 'space', weight: 4, a11yLabel: 'Space' },
  { id: 'backspace', chars: [], command: 'backspace', a11yLabel: 'Delete' },
  { id: 'enter', chars: [], command: 'enter', weight: 2, a11yLabel: 'Enter' },
];

/** `kind: 'numeric'`: a numpad for a PIN or an amount, entered with a D-Pad. */
const NUMERIC_ROWS: readonly (readonly KeySlot[])[] = [
  ['1', '2', '3'].map((char) => ({ id: `n${char}`, chars: [char] })),
  ['4', '5', '6'].map((char) => ({ id: `n${char}`, chars: [char] })),
  ['7', '8', '9'].map((char) => ({ id: `n${char}`, chars: [char] })),
  [
    { id: 'n.', chars: ['.'] },
    { id: 'n0', chars: ['0'] },
    { id: 'backspace', chars: [], command: 'backspace', a11yLabel: 'Delete' },
    { id: 'enter', chars: [], command: 'enter', weight: 2, a11yLabel: 'Enter' },
  ],
];

/** The four rows of the text keyboard: three letter rows and the command row. */
const TEXT_ROWS: readonly (readonly KeySlot[])[] = [
  TEXT_SLOTS.slice(0, 10),
  TEXT_SLOTS.slice(10, 19),
  [TEXT_SLOTS[19] as KeySlot, ...TEXT_SLOTS.slice(20, 28), TEXT_SLOTS[28] as KeySlot].filter(
    Boolean,
  ),
  TEXT_COMMANDS,
];

/** The glyphs of the non-character keys. */
export const COMMAND_GLYPH: Record<string, string> = {
  backspace: '⌫',
  enter: 'Enter',
  space: 'Space',
  shift: '⇧',
  shiftOn: '⇪',
};

/** Key geometry: one letter key is `KEY_UNIT` wide, and keys are `KEY_GAP` apart. */
export const KEY_UNIT = 30;
export const KEY_GAP = 6;

/** The rows for a page. The symbols page has no shift key — there is nothing to shift. */
export function keyboardRows(
  kind: VirtualKeyboardKind,
  page: KeyboardPage,
): readonly (readonly KeySlot[])[] {
  if (kind === 'numeric' || page === 'numeric') {
    return NUMERIC_ROWS;
  }
  if (page === 'symbols') {
    return [
      TEXT_ROWS[0] as readonly KeySlot[],
      TEXT_ROWS[1] as readonly KeySlot[],
      TEXT_ROWS[2] as readonly KeySlot[],
      TEXT_COMMANDS.filter((slot) => slot.command !== 'case'),
    ];
  }
  return TEXT_ROWS;
}

/** The page a keyboard of this kind shows, given its letters/symbols toggle. */
export function pageOf(kind: VirtualKeyboardKind, symbols: boolean): KeyboardPage {
  if (kind === 'numeric') {
    return 'numeric';
  }
  return symbols ? 'symbols' : 'letters';
}

/** What one slot shows right now: the character for the page and case, or the command glyph. */
export function labelFor(slot: KeySlot, page: KeyboardPage, upper: boolean): string {
  if (slot.command === 'page') {
    return page === 'symbols' ? 'ABC' : '123';
  }
  if (slot.command) {
    const glyph =
      COMMAND_GLYPH[slot.command === 'case' ? (upper ? 'shiftOn' : 'shift') : slot.command];
    return glyph ?? slot.id;
  }
  const char = slot.chars[page === 'symbols' ? 1 : 0] ?? slot.chars[0] ?? '';
  return page === 'letters' && upper ? char.toUpperCase() : char;
}

/**
 * The accessible name of a key.
 *
 * Almost always the fixed `a11yLabel` (a glyph says nothing: `⌫` → "Delete"). The page key is the
 * exception, because its *meaning* flips with the page: it is named after where it goes — "Numbers and
 * symbols" on the letters page, "Letters" on the symbols page — since a reader that says "Numbers and
 * symbols" while the player is standing on the numbers page is describing the current state, not the
 * button under the finger.
 */
export function a11yLabelFor(slot: KeySlot, page: KeyboardPage): string | undefined {
  if (slot.command === 'page') {
    return page === 'symbols' ? 'Letters' : 'Numbers and symbols';
  }
  return slot.a11yLabel;
}

/** How a key is drawn: a `Button` of `keyWidth()` px, highlighted when it is the submit key. */
export function describeSlot(
  slot: KeySlot,
  page: KeyboardPage,
  upper: boolean,
): { label: string; a11yLabel?: string; weight: number; primary: boolean } {
  const a11yLabel = a11yLabelFor(slot, page);
  return {
    label: labelFor(slot, page, upper),
    ...(a11yLabel ? { a11yLabel } : {}),
    weight: slot.weight ?? 1,
    primary: slot.command === 'enter',
  };
}

/** The width of a key of this weight: `weight` keys plus the gaps between them. */
export function keyWidth(weight: number): number {
  return weight * KEY_UNIT + (weight - 1) * KEY_GAP;
}

/**
 * The case state after pressing shift.
 *
 * off → one-shot upper → locked upper → off. The order is what makes a single tap usable and a double
 * tap convenient; anything else leaves the player pressing shift before every letter.
 */
export function pressShift(state: CaseState): CaseState {
  if (!state.upper) {
    return { upper: true, capsLock: false };
  }
  if (!state.capsLock) {
    return { upper: true, capsLock: true };
  }
  return CASE_OFF;
}

/** The case state after a character was typed: a one-shot shift releases, a lock stays. */
export function afterTyping(state: CaseState): CaseState {
  return state.capsLock ? state : CASE_OFF;
}
