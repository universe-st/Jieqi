/**
 * Music and sound effects.
 *
 * Two independent channels — a looping background track and one-shot cues — with their own volumes,
 * both persisted, plus a master mute. Keeping them separate is the whole point of the settings dialog:
 * a player who wants the music quiet but the pieces audible can have exactly that.
 *
 * ## Why the sound has to wait for a tap
 *
 * Every browser (and the Android WebView the Cordova build runs in) refuses to start audio until the
 * page has had a user gesture. Phaser tracks that in `sound.locked` and unlocks itself on the first
 * input, so the music is *started* eagerly but actually begins on whichever of these comes first: the
 * manager already being unlocked, the `unlocked` event, or the first pointer down. Without this the
 * track would silently never play on a phone.
 *
 * ## Why there is exactly one of these
 *
 * Phaser's `SoundManager` (and its `CacheManager`) are **game-global** — `scene.sound` is the same
 * object in every scene — so two directors would mean two instances of the same track playing on top of
 * each other the moment the menu hands over to the board. {@link audioDirector} therefore hands out one
 * shared instance, and the two scene-scoped things (queueing files, waiting for a gesture) take the
 * scene as an argument rather than holding one. The music then simply keeps playing across the
 * menu → draw → board transitions.
 */

import Phaser from 'phaser';

/** The looping background track. */
export const MUSIC_KEY = 'bgm';

/**
 * Every one-shot cue, mapped to the texture key it was loaded under.
 *
 * The names are the ones the game talks in ("place", "check"); the file names are an implementation
 * detail of `scripts/build-audio.sh`.
 */
export const SFX = {
  /** A HUD button or a menu item was activated. */
  click: 'sfx-click',
  /** A piece was picked up. */
  pick: 'sfx-pick',
  /** A piece landed on a square. */
  place: 'sfx-place',
  /** A face-down piece was turned over — the moment jieqi is about. */
  reveal: 'sfx-reveal',
  /** A piece was captured. */
  capture: 'sfx-capture',
  /** 将军 — somebody's general is under attack. */
  check: 'sfx-check',
  /** The opening shuffle. */
  deal: 'sfx-deal',
  /** A move was taken back. */
  undo: 'sfx-undo',
  win: 'sfx-win',
  lose: 'sfx-lose',
  draw: 'sfx-draw',
  /** The 定先后 piece turning — one cue long enough to cover the whole spin. */
  spin: 'sfx-spin',
  /** That piece settling onto a face. */
  land: 'sfx-land',
  /** 你执红 / 你执黑 — the draw's verdict. */
  omen: 'sfx-omen',
} as const;

export type SfxName = keyof typeof SFX;

const SFX_FILES: Record<SfxName, string> = {
  click: 'ui-click',
  pick: 'pick',
  place: 'place',
  reveal: 'reveal',
  capture: 'capture',
  check: 'check',
  deal: 'deal',
  undo: 'undo',
  win: 'win',
  lose: 'lose',
  draw: 'draw',
  spin: 'spin',
  land: 'land',
  omen: 'omen',
};

const STORAGE_KEY = 'jieqi.audio.v1';

export interface AudioSettings {
  /** 0…1 */
  music: number;
  /** 0…1 */
  sfx: number;
  muted: boolean;
}

export const DEFAULT_SETTINGS: AudioSettings = { music: 0.45, sfx: 0.75, muted: false };

/** Relative to the document, so it resolves under Vite's dev server *and* under Cordova's `file://`. */
const AUDIO_BASE = 'audio';

function clamp01(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function load(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      music: clamp01(parsed.music, DEFAULT_SETTINGS.music),
      sfx: clamp01(parsed.sfx, DEFAULT_SETTINGS.sfx),
      muted: parsed.muted === true,
    };
  } catch {
    // A corrupt or unavailable store is not worth failing a game over.
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * `volume` is declared on the concrete sound classes (`WebAudioSound`, `HTML5AudioSound`), not on the
 * `BaseSound` that `SoundManager#add` is typed to return — even though every sound Phaser can actually
 * create has one. Narrowing it here beats casting at each use site.
 */
type VolumedSound = Phaser.Sound.BaseSound & { volume: number };

export class AudioDirector {
  /** The game-global sound manager, captured once: it outlives any single scene. */
  private readonly sound: Phaser.Sound.BaseSoundManager;
  /** Also game-global, and what `play()` checks before asking for a key that was never loaded. */
  private readonly cache: Phaser.Cache.CacheManager;
  private settings: AudioSettings = load();
  private music: VolumedSound | null = null;
  /** Set once the loader has finished, so a cue asked for during load is dropped rather than thrown. */
  private ready = false;

  constructor(scene: Phaser.Scene) {
    this.sound = scene.sound;
    this.cache = scene.cache;
  }

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------

  /** Queues the whole soundtrack. Call from a scene's `preload()`. */
  preload(scene: Phaser.Scene): void {
    // Skip anything already decoded: a second scene (or a restarted one) would otherwise re-download
    // the lot — 3 MB of music, on a phone.
    const queue = (key: string, url: string): void => {
      if (!this.cache.audio.has(key)) scene.load.audio(key, url);
    };
    queue(MUSIC_KEY, `${AUDIO_BASE}/bgm.mp3`);
    for (const name of Object.keys(SFX_FILES) as SfxName[]) {
      queue(SFX[name], `${AUDIO_BASE}/sfx/${SFX_FILES[name]}.mp3`);
    }
    // A missing file must not stop the game from starting: the board is playable in silence.
    scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: { key?: string }) => {
      console.warn(`[jieqi] audio failed to load: ${file?.key ?? 'unknown'}`);
    });
  }

  /** Begins the music, waiting for the audio context if the browser has locked it. */
  start(scene: Phaser.Scene): void {
    this.ready = true;
    if (this.music) return;
    const begin = (): void => this.ensureMusic();
    if (scene.sound.locked) {
      scene.sound.once(Phaser.Sound.Events.UNLOCKED, begin);
      // Belt and braces: a WebView that never emits `unlocked` still gets music on the first tap.
      scene.input.once(Phaser.Input.Events.POINTER_DOWN, begin);
    } else {
      begin();
    }
  }

  private ensureMusic(): void {
    if (!this.ready || this.music) return;
    if (!this.cache.audio.has(MUSIC_KEY)) return;
    this.music = this.sound.add(MUSIC_KEY, {
      loop: true,
      volume: this.effectiveMusic,
    }) as VolumedSound;
    this.music.play();
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  get musicVolume(): number {
    return this.settings.music;
  }

  set musicVolume(value: number) {
    this.settings.music = clamp01(value, this.settings.music);
    // `volume` is a live property on a Phaser sound (it writes straight into the gain node), so a
    // drag in the settings dialog is heard while it happens rather than after it.
    if (this.music) this.music.volume = this.effectiveMusic;
    this.persist();
  }

  get sfxVolume(): number {
    return this.settings.sfx;
  }

  set sfxVolume(value: number) {
    this.settings.sfx = clamp01(value, this.settings.sfx);
    this.persist();
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  set muted(value: boolean) {
    this.settings.muted = value === true;
    if (this.music) this.music.volume = this.effectiveMusic;
    this.persist();
  }

  /** What the settings *say* about the music channel, master mute included. */
  private get effectiveMusic(): number {
    return this.settings.muted ? 0 : this.settings.music;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Private browsing, a full quota — neither is a reason to interrupt play.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------------------------

  /**
   * Fires a one-shot cue.
   *
   * Phaser picks an idle instance of the sound, or adds another, so a rapid burst of clicks overlaps
   * instead of cutting itself off. `volume` is passed per play so a change in the settings dialog is
   * audible on the very next cue.
   */
  play(name: SfxName, options: { detune?: number; volume?: number } = {}): void {
    if (!this.ready || this.settings.muted || this.settings.sfx <= 0) return;
    const key = SFX[name];
    if (!this.cache.audio.has(key)) return;
    this.sound.play(key, {
      volume: this.settings.sfx * (options.volume ?? 1),
      ...(options.detune === undefined ? {} : { detune: options.detune }),
    });
  }

  /** Stops the music outright. Nothing calls this in normal play — the track spans every scene. */
  stop(): void {
    this.music?.stop();
    this.music = null;
  }

  /** True once a track exists and is actually playing — what an acceptance run asserts on. */
  get musicPlaying(): boolean {
    return this.music?.isPlaying ?? false;
  }
}

/**
 * The one director for the whole game.
 *
 * `SoundManager` and `CacheManager` are game-global (see the class comment), so a second instance would
 * be a second copy of the same loop rather than a second channel. The first caller's scene is only used
 * to reach those two managers; every scene-scoped call takes its scene explicitly.
 */
let shared: AudioDirector | null = null;

export function audioDirector(scene: Phaser.Scene): AudioDirector {
  shared ??= new AudioDirector(scene);
  return shared;
}
