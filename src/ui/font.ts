/**
 * The game's typeface, fetched once at cold start.
 *
 * 霞鹜文楷 (LXGW WenKai) is a 楷体-flavoured screen font, and it is the *whole* game's look: the pieces,
 * the 楚河汉界 on the board, the menu, the move log. It is converted from the upstream 25 MB TrueType
 * face to a 7.9 MB WOFF2 by `scripts/build-font.sh`, which is why it is loaded rather than declared in
 * CSS: a `@font-face` rule gives no progress, and eight megabytes with a blank screen is a worse
 * first impression than eight megabytes with a bar on it.
 *
 * So the file is streamed here, byte counts and all, handed to a `FontFace`, and only then is the game
 * allowed to build itself — the pieces are baked into textures with a canvas 2D context, and a canvas
 * that is asked for a glyph before the face lands draws the *fallback* and never repaints.
 *
 * Failing is allowed: on a device where the fetch or the parse goes wrong the game falls back to the
 * system serif stack behind `FONT_FAMILY` in `palette.ts` and plays anyway. A missing font is not worth
 * an unplayable game.
 */

import { FONT_FAMILY } from './palette';

/** Relative to the document, so it resolves under Vite's dev server *and* inside the Cordova APK. */
export const FONT_FILE = 'fonts/LXGWWenKai-Regular.woff2';

/** Used only when the response reports no length at all — see {@link creep}. */
const ASSUMED_BYTES = 7_900_000;

export type FontProgress = (fraction: number) => void;

/**
 * How far along a download is when the server will not say how big it is.
 *
 * Approaches 1 without ever reaching it, so the bar keeps moving for the whole download and still snaps
 * to done when the last chunk lands. The scale factor is the file's own size: this is an estimate of the
 * *same* 8 MB, not a guess with a timer in it.
 */
function creep(received: number): number {
  return 1 - Math.exp(-received / ASSUMED_BYTES);
}

/** Streams `url`, reporting `0…1` as it goes, and returns the bytes. */
async function download(url: string, onProgress?: FontProgress): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`font request failed: HTTP ${response.status}`);

  const declared = Number(response.headers.get('content-length') ?? '');
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
  const body = response.body;
  if (!body) {
    // No streaming reader (or no body at all): one hop, no progress to report.
    const buffer = await response.arrayBuffer();
    onProgress?.(1);
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(total > 0 ? received / total : creep(received));
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Puts the bytes into `document.fonts` under {@link FONT_FAMILY}.
 *
 * Two paths, because the direct one is the good one: `FontFace` from an `ArrayBuffer` skips the MIME
 * sniffing and the second network request that a `@font-face` rule would need. An old WebView without
 * the constructor gets the blob-URL rule instead — the same font, one indirection further away.
 */
async function install(buffer: ArrayBuffer): Promise<void> {
  if (typeof FontFace === 'function') {
    const face = new FontFace(FONT_FAMILY, buffer);
    // Added before it is awaited so the loading page re-paints in 霞鹜文楷 the moment it is ready — that
    // page is the one thing on screen while this runs.
    document.fonts.add(face);
    try {
      await face.load();
    } catch (error) {
      document.fonts.delete(face);
      throw error;
    }
    return;
  }

  const url = URL.createObjectURL(new Blob([buffer], { type: 'font/woff2' }));
  const style = document.createElement('style');
  style.textContent = `@font-face{font-family:"${FONT_FAMILY}";src:url("${url}") format("woff2");font-display:block;}`;
  document.head.appendChild(style);
  await document.fonts.load(`16px "${FONT_FAMILY}"`);
}

/**
 * Loads the face, reporting progress on the way.
 *
 * Resolves `true` when the font is ready to be measured and drawn with, `false` when it is not — and
 * never rejects, because "the font did not arrive" is a state the game is designed to survive.
 */
export async function loadGameFont(onProgress?: FontProgress): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false;
  try {
    const url = new URL(FONT_FILE, document.baseURI).href;
    const buffer = await download(url, onProgress);
    if (buffer.byteLength === 0) throw new Error('font file is empty');
    await install(buffer);
    onProgress?.(1);
    return true;
  } catch (error) {
    console.warn('[jieqi] LXGW WenKai did not load; falling back to the system serif:', error);
    return false;
  }
}
