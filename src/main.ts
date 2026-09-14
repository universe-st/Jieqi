/**
 * Entry point: loads the typeface, then builds the Phaser game, installs the 古风 theme, and mounts the
 * acceptance backdoor.
 *
 * Four scenes, in the order a session actually visits them: **载入 → 开始界面 → 定先后 → 棋盘**. Only the
 * first is started automatically; each hands over to the next explicitly, which is what keeps "the
 * player's colour" a value that is *passed* from the draw to the board rather than a global somebody has
 * to remember to update.
 *
 * The font is fetched **before** the game is constructed, and that ordering is load-bearing rather than
 * tidy: pieces, the 楚河汉界 on the board and every HUD chip are baked into textures through a canvas 2D
 * context, and a canvas asked for a glyph before the face has landed draws the fallback and never
 * repaints. Loading it here means the first thing the game ever draws is already in 霞鹜文楷 — and the
 * progress of that download is what the loading page (a DOM overlay, `ui/loading.ts`) reports, together
 * with the soundtrack the boot scene queues.
 */

import Phaser from 'phaser';
import { MVVMPlugin, setTheme } from '@phaser-mvvm/phaser';

import { installBackdoor } from './debug/backdoor';
import { BootScene } from './scenes/BootScene';
import { DrawScene } from './scenes/DrawScene';
import { GameScene } from './scenes/GameScene';
import { StartScene } from './scenes/StartScene';
import { loadGameFont } from './ui/font';
import { loadingPage } from './ui/loading';
import { C, DESIGN_HEIGHT, DESIGN_WIDTH } from './ui/palette';
import { JIEQI_THEME } from './ui/theme';

const page = loadingPage();

async function boot(): Promise<void> {
  page.setPhase('正在载入字体');
  // Resolves either way: a font that cannot be fetched is a game in the system serif, not a dead screen.
  await loadGameFont((fraction) => page.setFont(fraction));

  page.setPhase('正在载入音乐');

  // Set before the first widget exists, so nothing is ever painted in the framework's default palette.
  setTheme(JIEQI_THEME);

  // The UI layer lays out in the same design units as the drawing buffer: no `designResolution` split,
  // so pages, snap grid and glyph density all live at one buffer pixel per design pixel. See
  // `ui/render-scale`.

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: C.backdrop,
    scale: {
      // A fixed design resolution scaled to fit. The board and the HUD are then pixel-identical on every
      // phone, which is what a board game wants — a reflowing chessboard is a worse chessboard.
      //
      // The buffer is exactly the 450×900 design and the browser upscales the canvas to fit the screen,
      // which is what gives the board its slightly soft look. That is the intended look (see the 1.2.3
      // revert); a device-resolution pass made it razor-sharp and was judged too harsh.
      mode: Phaser.Scale.FIT,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      antialias: true,
      // Keeps the drawing buffer around, so an automated screenshot of the WebGL canvas is never blank.
      preserveDrawingBuffer: true,
    },
    // The framework's DOM input bridge and accessibility mirror need a container to attach to.
    dom: { createContainer: true },
    plugins: {
      scene: [{ key: 'MVVMPlugin', plugin: MVVMPlugin, mapping: 'mvvm', start: true }],
    },
    // The first entry is started for us; the rest are reached with `scene.start(...)`. `boot` queues the
    // soundtrack and hands over to the menu, so no screen is ever the first to wait for a file.
    scene: [BootScene, StartScene, DrawScene, GameScene],
  });

  installBackdoor(game);

  (window as unknown as { jieqiGame: Phaser.Game }).jieqiGame = game;
}

void boot();
