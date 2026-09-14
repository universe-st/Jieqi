/**
 * 载入 — the scene that owns the loading page's second half.
 *
 * The font is already in by the time this runs (`main.ts` awaits it before the game exists at all, so
 * every canvas-baked glyph in the game is drawn with the real face). What is left is the soundtrack:
 * fifteen files, 3 MB of music among them, queued here rather than in the menu because a title screen
 * that appears and then stutters when the first button is pressed is worse than one that waits a second
 * with a progress bar on screen.
 *
 * That is the whole scene. It draws nothing — the loading page is DOM, sitting over the canvas — and its
 * `create()` is reached exactly when the loader has finished, which is the moment the page can be taken
 * away and the menu handed the screen.
 *
 * The other scenes still call `AudioDirector.preload()`, which is a no-op once the cache has the files;
 * leaving those calls in place keeps any of them playable if it is ever started on its own (the
 * acceptance backdoor does exactly that).
 */

import Phaser from 'phaser';

import { audioDirector, type AudioDirector } from '../audio/AudioDirector';
import { loadingPage } from '../ui/loading';
import { applyRenderScale } from '../ui/render-scale';

export class BootScene extends Phaser.Scene {
  private audio!: AudioDirector;

  constructor() {
    super('boot');
  }

  preload(): void {
    const page = loadingPage();
    this.audio = audioDirector(this);
    this.audio.preload(this);
    // Phaser counts *files*, not bytes, so the bar's audio share advances in fifteen steps — but it is
    // real progress, and the 3 MB track is one of them.
    this.load.on(Phaser.Loader.Events.PROGRESS, (value: number) => page.setAudio(value));
  }

  create(): void {
    applyRenderScale(this);
    // The page fades out over the menu's own fade-in: the canvas is already painted behind it, so the
    // hand-over is a cross-fade rather than a flash of empty screen.
    loadingPage().finish();
    this.scene.start('start');
  }
}
