/**
 * The loading page — the DOM splash that covers the screen while the font and the soundtrack arrive.
 *
 * It is deliberately **not** a Phaser scene. The two things it has to report on are the two things that
 * happen before there is anything to render: the 7.9 MB of 霞鹜文楷 and the 3 MB of audio. A Phaser
 * scene could not draw its own progress bar in the game's font before that font exists, and the browser
 * *can*: text laid out in a DOM element re-paints by itself the moment the face lands in
 * `document.fonts`, so the "揭 棋" on this page is the first thing the player sees in the game's typeface
 * — even though it was painted in a fallback a fraction of a second earlier.
 *
 * The elements live in `index.html` rather than being built here, so the page exists from the very first
 * paint — before a single byte of JavaScript has been parsed, which is exactly when a cold start most
 * needs something on screen.
 *
 * Every method is null-safe: the page is one `getElementById` away from being absent (a unit test, a
 * stripped build, a harness that loads the bundle some other way), and nothing about a loading bar is
 * worth throwing over.
 */

/** How much of the bar belongs to the font. The rest is the soundtrack — weighted by bytes, 7.9 : 3.3. */
const FONT_SHARE = 0.7;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export class LoadingPage {
  private readonly veil: HTMLElement | null;
  private readonly bar: HTMLElement | null;
  private readonly fill: HTMLElement | null;
  private readonly note: HTMLElement | null;

  /** The bar only ever moves forward: two loaders report into it, and neither may undo the other. */
  private fraction = 0;
  private phase = '';

  constructor(root: Document | HTMLElement = document) {
    const find = (id: string): HTMLElement | null => root.querySelector<HTMLElement>(`#${id}`);
    this.veil = find('boot-veil');
    this.bar = find('boot-bar');
    this.fill = find('boot-fill');
    this.note = find('boot-note');
  }

  /** True when the page is actually in the document. */
  get mounted(): boolean {
    return this.veil !== null;
  }

  /** Which of the two loads is being reported right now — the line under the bar. */
  setPhase(phase: string): void {
    this.phase = phase;
    this.render();
  }

  /** `0…1` through the font download *and* the parse that follows it. The first {@link FONT_SHARE}. */
  setFont(fraction: number): void {
    this.advance(FONT_SHARE * clamp01(fraction));
  }

  /** `0…1` through Phaser's audio queue — the remaining share of the bar. */
  setAudio(fraction: number): void {
    this.advance(FONT_SHARE + (1 - FONT_SHARE) * clamp01(fraction));
  }

  /**
   * Fades the page out and takes it out of the tab order.
   *
   * Called as the menu mounts, so the two cross-fade rather than the screen going black between them:
   * the fade is a CSS transition and the canvas is already behind it.
   */
  finish(): void {
    this.advance(1);
    this.veil?.classList.add('gone');
    this.veil?.setAttribute('aria-hidden', 'true');
  }

  private advance(fraction: number): void {
    this.fraction = Math.max(this.fraction, clamp01(fraction));
    this.render();
  }

  private render(): void {
    const percent = Math.round(this.fraction * 100);
    if (this.fill) this.fill.style.width = `${percent}%`;
    if (this.note) this.note.textContent = this.phase ? `${this.phase} · ${percent}%` : `${percent}%`;
    // The bar is a `progressbar` for anything reading the page rather than looking at it — and it is how
    // an acceptance run can tell "still loading" from "stuck behind an overlay".
    this.bar?.setAttribute('aria-valuenow', String(percent));
  }
}

/** The one page for the session. */
let shared: LoadingPage | null = null;

export function loadingPage(): LoadingPage {
  shared ??= new LoadingPage();
  return shared;
}
