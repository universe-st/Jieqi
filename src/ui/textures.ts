/**
 * Textures, drawn at boot.
 *
 * The game ships no art assets on purpose: everything is a `Graphics` command list baked into a
 * texture once. That keeps the Cordova bundle tiny, avoids any licensing question, and means the whole
 * 古风 look is expressed as code that can be reviewed and tweaked.
 *
 * Textures are baked rather than drawn every frame because a piece is moved, scaled and faded by the
 * tween system; a `Graphics` object per piece would mean rebuilding its command list on every flip.
 */

import Phaser from 'phaser';
import type { Color, Kind } from '../core/types';
import { KIND_NAME } from '../core/types';
import { C, PIECE_RADIUS, SERIF_STACK, hex } from './palette';
import { BAKE_SCALE } from './render-scale';

/** Displayed size of one captured-piece chip in the HUD. */
export const CHIP_DISPLAY = 26;
/** Baked at the device's density so the chips stay crisp on a high-density screen. */
const CHIP_BAKE = CHIP_DISPLAY * BAKE_SCALE;

export const TEX = {
  discRed: 'disc-red',
  discBlack: 'disc-black',
  discBack: 'disc-back',
  /** The side of a piece, seen when it is turning edge-on during the 定先后 spin. */
  discEdge: 'disc-edge',
  glow: 'glow',
  glowRed: 'glow-red',
  /** 吃子提示 halos: red under a piece of ours that can be taken, green under one of theirs. */
  glowOwn: 'glow-own',
  glowFoe: 'glow-foe',
  spark: 'spark',
  ring: 'ring',
  petalRed: 'petal-red',
  petalGold: 'petal-gold',
  chipBack: 'chip-back',
  /** 迷雾: one soft-edged tile per fogged square, plus a smaller drifting wisp for the particle effect. */
  fog: 'fog',
  mist: 'mist',
} as const;

/** Bake size of the edge strip; the spin scales it to whatever the piece's diameter is. */
const EDGE_WIDTH = 30;
const EDGE_HEIGHT = 220;

/**
 * Texture key for a captured-piece chip.
 *
 * `kind` is required — the trays never render an identity they are not allowed to show as a face; they
 * ask for the back instead.
 */
export function chipTexture(color: Color, kind: Kind, dim = false): string {
  return `chip-${color}-${kind}${dim ? '-dim' : ''}`;
}

const DISC_SIZE = PIECE_RADIUS * 2 + 8;
const DISC_CENTER = DISC_SIZE / 2;

/**
 * The size a piece's disc is **displayed** at, in design pixels.
 *
 * Exported because the discs are baked at {@link BAKE_SCALE} samples per design pixel: every consumer has
 * to say how big the picture is, or the extra pixels turn into a bigger piece.
 */
export const PIECE_DISPLAY = DISC_SIZE;

/**
 * Draws a playing piece: a bevelled ivory disc with a coloured rim.
 *
 * Both sides are the same material — as on a real set, where only the carved character differs — but
 * the two faces are tinted a little apart, because on a phone a board of sixteen identical ivory discs
 * is much harder to read than a board of wooden ones.
 */
function drawFace(
  g: Phaser.GameObjects.Graphics,
  rim: number,
  face: number,
  faceShade: number,
): void {
  // Drop edge: a slightly larger dark disc gives the piece thickness without a real shadow.
  g.fillStyle(0x000000, 0.3);
  g.fillCircle(DISC_CENTER, DISC_CENTER + 1.7, PIECE_RADIUS + 1.2);

  g.fillStyle(rim, 1);
  g.fillCircle(DISC_CENTER, DISC_CENTER, PIECE_RADIUS + 1);

  // The face is offset a hair up-left so the rim reads as a bevel rather than an outline.
  g.fillStyle(faceShade, 1);
  g.fillCircle(DISC_CENTER - 0.4, DISC_CENTER - 0.4, PIECE_RADIUS - 1);
  g.fillStyle(face, 1);
  g.fillCircle(DISC_CENTER - 1.2, DISC_CENTER - 1.4, PIECE_RADIUS - 2.4);

  g.lineStyle(1, rim, 0.8);
  g.strokeCircle(DISC_CENTER - 0.6, DISC_CENTER - 0.8, PIECE_RADIUS - 5);
}

/**
 * The back of a face-down piece.
 *
 * Every 暗子 looks exactly the same — that is the whole game. The motif is a carved sandalwood rosette,
 * so a face-down piece reads as "sealed" rather than as "missing a texture".
 */
function drawBack(g: Phaser.GameObjects.Graphics): void {
  g.fillStyle(0x000000, 0.3);
  g.fillCircle(DISC_CENTER, DISC_CENTER + 1.8, PIECE_RADIUS + 1.2);

  g.fillStyle(C.sandal, 1);
  g.fillCircle(DISC_CENTER, DISC_CENTER, PIECE_RADIUS + 1);
  g.fillStyle(C.sandalLight, 1);
  g.fillCircle(DISC_CENTER - 1, DISC_CENTER - 1.2, PIECE_RADIUS - 2);

  g.lineStyle(1.5, C.goldBright, 0.72);
  g.strokeCircle(DISC_CENTER, DISC_CENTER, PIECE_RADIUS - 5);
  g.lineStyle(0.9, C.goldBright, 0.45);
  g.strokeCircle(DISC_CENTER, DISC_CENTER, PIECE_RADIUS - 8.5);

  // Four carved petals around a lozenge: explicit trigonometry rather than canvas transforms, so the
  // bake does not depend on how `generateTexture` treats transform commands.
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4;
    const px = DISC_CENTER + Math.cos(angle) * (PIECE_RADIUS - 10);
    const py = DISC_CENTER + Math.sin(angle) * (PIECE_RADIUS - 10);
    g.fillStyle(C.goldBright, 0.68);
    g.fillCircle(px, py, 2.1);
  }
  const arm = 4.2;
  g.fillStyle(C.goldBright, 0.6);
  g.beginPath();
  g.moveTo(DISC_CENTER, DISC_CENTER - arm);
  g.lineTo(DISC_CENTER + arm, DISC_CENTER);
  g.lineTo(DISC_CENTER, DISC_CENTER + arm);
  g.lineTo(DISC_CENTER - arm, DISC_CENTER);
  g.closePath();
  g.fillPath();
}

/**
 * The side of a piece: a sandalwood stadium.
 *
 * Only ever seen mid-turn, when the piece is close to edge-on — which is exactly why it has to exist:
 * without it a spinning piece flickers out of existence twice per rotation, at the frames the eye is
 * most likely to catch.
 */
function drawEdge(g: Phaser.GameObjects.Graphics): void {
  const w = EDGE_WIDTH;
  const h = EDGE_HEIGHT;
  const cap = w / 2;

  g.fillStyle(0x140c08, 1);
  g.fillRoundedRect(0, 0, w, h, cap);
  g.fillStyle(C.sandal, 1);
  g.fillRoundedRect(1, 2, w - 2, h - 4, (w - 2) / 2);
  // Two lighter bands rather than one: a single highlight reads as a plank, a pair reads as the
  // rounded rim of a turned piece.
  g.fillStyle(C.sandalLight, 0.95);
  g.fillRoundedRect(w * 0.2, 4, w * 0.26, h - 8, w * 0.13);
  g.fillRoundedRect(w * 0.54, 4, w * 0.26, h - 8, w * 0.13);
  g.fillStyle(C.goldBright, 0.22);
  g.fillRoundedRect(w * 0.44, 8, w * 0.12, h - 16, w * 0.06);
}

/** A soft radial glow, used for selection auras, shockwaves and the thinking indicator. */
function drawGlow(g: Phaser.GameObjects.Graphics, size: number, color: number): void {
  const centre = size / 2;
  const steps = 26;
  for (let i = steps; i > 0; i--) {
    const t = i / steps;
    const radius = centre * t;
    // Alpha rises towards the middle so the falloff looks smooth without a real gradient shader.
    g.fillStyle(color, 0.035 * (1 - t) * (1 - t) * 3.2);
    g.fillCircle(centre, centre, radius);
  }
}

/** A tiny four-point star, thrown on captures and landings. */
function drawSpark(g: Phaser.GameObjects.Graphics): void {
  const size = 12;
  const centre = size / 2;
  g.fillStyle(0xffffff, 0.18);
  g.fillCircle(centre, centre, centre);
  g.fillStyle(0xffffff, 0.9);
  g.beginPath();
  g.moveTo(centre, 1);
  g.lineTo(centre + 1.2, centre);
  g.lineTo(centre, size - 1);
  g.lineTo(centre - 1.2, centre);
  g.closePath();
  g.fillPath();
  g.beginPath();
  g.moveTo(1, centre);
  g.lineTo(centre, centre - 1.2);
  g.lineTo(size - 1, centre);
  g.lineTo(centre, centre + 1.2);
  g.closePath();
  g.fillPath();
}

/** A thin ring, scaled up by tweens for the shockwave and the legal-move marker. */
function drawRing(g: Phaser.GameObjects.Graphics): void {
  const size = 64;
  const centre = size / 2;
  g.lineStyle(2.5, 0xffffff, 1);
  g.strokeCircle(centre, centre, centre - 3);
}

/** A petal for the endgame fall — a plain ellipse the tween rotates as it drifts down. */
function drawPetal(g: Phaser.GameObjects.Graphics, color: number): void {
  g.fillStyle(color, 0.9);
  g.fillEllipse(9, 6, 11, 5.5);
  g.fillStyle(0xffffff, 0.25);
  g.fillEllipse(7.5, 5.2, 5.5, 2.2);
}

/**
 * 迷雾 mode: one translucent tile per fogged square.
 *
 * Restored to the soft style on 2026-09-15 (user: "迷雾还是之前的样式就好，棋子隐藏就行") — pieces under
 * the fog are not drawn at all (`BoardView.reconcile` hides them), so the tile itself only needs to be
 * weather, not a wall. A soft layered square slightly oversized so adjacent tiles overlap instead of
 * showing seams; the drifting wisps on top are what make it read as weather rather than paint.
 */
function drawFogTile(g: Phaser.GameObjects.Graphics, size: number): void {
  const half = size / 2;
  const steps = 30;
  for (let i = steps; i > 0; i--) {
    const t = i / steps;
    const s = half * t * 1.04; // a hair oversized, so tiles overlap instead of showing seams
    const alpha = (1 - t) * (1 - t) * 2.4;
    g.fillStyle(0x93a8c2, alpha);
    g.fillRect(half - s, half - s, s * 2, s * 2);
  }
}

/**
 * 迷雾 mode: the drifting wisp that makes the fog read as weather rather than paint.
 *
 * A small soft blob at low alpha; the board layer wanders it between fogged squares and lets it
 * dissolve whenever a move's new vision catches it in the open.
 */
function drawMist(g: Phaser.GameObjects.Graphics, size: number): void {
  const centre = size / 2;
  const steps = 20;
  for (let i = steps; i > 0; i--) {
    const t = i / steps;
    const alpha = (1 - t) * (1 - t) * 2.0;
    g.fillStyle(0xaebdd0, alpha);
    g.fillCircle(centre, centre, centre * t);
  }
}

/**
 * Draws a chip into a plain 2D context, fully opaque.
 *
 * The chips are the one thing drawn on a canvas rather than through `Graphics`, because they need two
 * things `Graphics` cannot give: a real glyph, and a *uniform* alpha for the "you captured this face
 * down" state. Laying two translucent circles on top of one another would leave the middle twice as
 * opaque as the rim; painting opaque first and compositing once is the only way to get a flat 50%.
 */
function paintChip(ctx: CanvasRenderingContext2D, color: Color | null, kind: Kind | null): void {
  const centre = CHIP_BAKE / 2;
  const radius = CHIP_BAKE * 0.46;

  const circle = (r: number, fill: string): void => {
    ctx.beginPath();
    ctx.arc(centre, centre, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  if (color === null || kind === null) {
    // The back: sandalwood with the same carved rosette the board pieces wear.
    circle(radius, hex(C.sandal));
    circle(radius * 0.9, hex(C.sandalLight));
    ctx.strokeStyle = hex(C.goldBright);
    ctx.lineWidth = CHIP_BAKE * 0.035;
    ctx.beginPath();
    ctx.arc(centre, centre, radius * 0.66, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = hex(C.goldBright);
    const arm = radius * 0.3;
    ctx.beginPath();
    ctx.moveTo(centre, centre - arm);
    ctx.lineTo(centre + arm, centre);
    ctx.lineTo(centre, centre + arm);
    ctx.lineTo(centre - arm, centre);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  const rim = color === 'red' ? C.cinnabar : 0x2a2622;
  circle(radius, hex(rim));
  circle(radius * 0.88, hex(C.ivory));
  ctx.strokeStyle = hex(rim);
  ctx.lineWidth = CHIP_BAKE * 0.035;
  ctx.beginPath();
  ctx.arc(centre, centre, radius * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = hex(color === 'red' ? C.cinnabar : C.ink);
  ctx.font = `${Math.round(radius * 1.02)}px ${SERIF_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(KIND_NAME[color][kind], centre, centre + CHIP_BAKE * 0.015);
}

/**
 * Bakes every chip the HUD can ask for: the back, and each side's seven identities in both a solid and
 * a half-transparent version.
 */
function bakeChips(scene: Phaser.Scene): void {
  interface ChipSpec {
    key: string;
    color: Color | null;
    kind: Kind | null;
    alpha: number;
  }

  const keys = (): ChipSpec[] => {
    const out: ChipSpec[] = [{ key: TEX.chipBack, color: null, kind: null, alpha: 1 }];
    for (const color of ['red', 'black'] as const) {
      for (const kind of ['K', 'A', 'E', 'H', 'R', 'C', 'P'] as const) {
        out.push({ key: chipTexture(color, kind), color, kind, alpha: 1 });
        // 0.5 read as a smudge on the dark HUD panel — the face, the glyph and the rim all washed
        // into the wood. 0.72 keeps "this was face down when I took it" legible as a *piece*.
        out.push({ key: chipTexture(color, kind, true), color, kind, alpha: 0.72 });
      }
    }
    return out;
  };

  const pending = keys().filter((chip) => !scene.textures.exists(chip.key));
  if (pending.length === 0) return;

  // One opaque scratch canvas, composited once per chip so the alpha comes out flat.
  const scratch = document.createElement('canvas');
  scratch.width = CHIP_BAKE;
  scratch.height = CHIP_BAKE;
  const scratchCtx = scratch.getContext('2d');

  for (const chip of pending) {
    if (!scratchCtx) break;
    scratchCtx.clearRect(0, 0, CHIP_BAKE, CHIP_BAKE);
    scratchCtx.globalAlpha = 1;
    paintChip(scratchCtx, chip.color, chip.kind);

    const texture = scene.textures.createCanvas(chip.key, CHIP_BAKE, CHIP_BAKE);
    if (!texture) continue;
    const ctx = texture.context;
    ctx.clearRect(0, 0, CHIP_BAKE, CHIP_BAKE);
    ctx.globalAlpha = chip.alpha;
    ctx.drawImage(scratch, 0, 0);
    ctx.globalAlpha = 1;
    texture.refresh();
  }
}

/**
 * Bakes every texture. Safe to call more than once; existing keys are skipped so a scene restart does
 * not thrash the texture manager.
 */
export function buildTextures(scene: Phaser.Scene): void {
  // `scaled` marks the textures whose consumers *always* set an explicit display size (a piece disc, a
  // glow, the edge strip). Those can be baked at BAKE_SCALE, so the camera's device-resolution zoom has
  // real pixels to magnify instead of a 1× bitmap. The sprites left at 1× are the particle ones (spark,
  // petal, and the ring `fx` tweens by `scale`), which are drawn at their natural size: a denser bake
  // would simply make every spark bigger.
  const bake = (
    key: string,
    width: number,
    height: number,
    draw: (g: Phaser.GameObjects.Graphics) => void,
    scaled = false,
  ): void => {
    if (scene.textures.exists(key)) return;
    const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
    draw(graphics);
    const density = scaled ? BAKE_SCALE : 1;
    // `generateTexture` renders through Phaser's canvas transform, which applies *this object's* scale, so
    // scaling the Graphics bakes the same picture at `density` samples per design unit — no drawing
    // function has to know anything about it.
    graphics.setScale(density);
    graphics.generateTexture(key, Math.round(width * density), Math.round(height * density));
    graphics.destroy();
  };

  bake(
    TEX.discRed,
    DISC_SIZE,
    DISC_SIZE,
    (g) => drawFace(g, C.cinnabar, 0xf6e6c2, 0xd9b98a),
    true,
  );
  bake(
    TEX.discBlack,
    DISC_SIZE,
    DISC_SIZE,
    (g) => drawFace(g, 0x2a2622, 0xe9e6de, 0xc2bcae),
    true,
  );
  bake(TEX.discBack, DISC_SIZE, DISC_SIZE, drawBack, true);
  bake(TEX.discEdge, EDGE_WIDTH, EDGE_HEIGHT, drawEdge, true);
  bake(TEX.glow, 160, 160, (g) => drawGlow(g, 160, C.gold), true);
  bake(TEX.glowRed, 160, 160, (g) => drawGlow(g, 160, C.check), true);
  bake(TEX.glowOwn, 160, 160, (g) => drawGlow(g, 160, C.hintOwn), true);
  bake(TEX.glowFoe, 160, 160, (g) => drawGlow(g, 160, C.hintFoe), true);
  bake(TEX.spark, 12, 12, drawSpark);
  bake(TEX.ring, 64, 64, drawRing);
  bake(TEX.petalRed, 18, 12, (g) => drawPetal(g, C.cinnabar));
  bake(TEX.petalGold, 18, 12, (g) => drawPetal(g, C.goldBright));
  // 迷雾: the tile is set to an explicit display size per square, the wisp is scaled by its drift
  // tween — both get the dense bake so the mist stays smooth on a high-density screen.
  bake(TEX.fog, 64, 64, (g) => drawFogTile(g, 64), true);
  bake(TEX.mist, 24, 24, (g) => drawMist(g, 24), true);

  bakeChips(scene);
}
