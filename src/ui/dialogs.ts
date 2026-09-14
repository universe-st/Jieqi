/**
 * The two settings dialogs, shared by the start menu and the in-game HUD.
 *
 * They live here rather than inside a scene because both screens need exactly the same thing — the menu
 * has 难度设置 / 音量设置 as menu entries, and the board keeps them one tap away in the top bar — and two
 * copies of a mixer is how a slider ends up writing to a different place than the label it sits next to.
 *
 * Both are built with the Compose DSL and handed to the plugin's modal stack, so `Esc`, the scrim and
 * the focus trap come for free.
 */

import { ref } from '@phaser-mvvm/core';
import type { MVVMPlugin } from '@phaser-mvvm/phaser';
import {
  Button,
  Column,
  Divider,
  Panel,
  Row,
  Slider,
  Spacer,
  Text,
} from '@phaser-mvvm/widgets/compose';

import { DIFFICULTY, type Difficulty } from '../ai';
import type { AudioDirector } from '../audio/AudioDirector';
import { DIFFICULTY_LABEL } from '../vm/GameViewModel';
import { DIFFICULTIES } from '../vm/prefs';

/**
 * The mixer.
 *
 * Both sliders write straight through to the {@link AudioDirector}, so a drag is heard while it
 * happens — the music channel immediately, the effects channel on the next cue (and on the short
 * preview the slider fires, so "is this too quiet?" has an answer without leaving the dialog).
 *
 * The values live in `ref`s only so the percentage labels can follow them; the director remains the
 * single source of truth, which is what gets persisted.
 *
 * Those two percentages are the *only* place the levels are written down. The menu entry that opens this
 * dialog is labelled 音量设置 and nothing else: a button that reads "音量设置 · 音效 60% · 音乐 40%" is a
 * value the player cannot edit sitting on a control they can, and it goes stale the moment the dialog
 * changes it.
 */
export function openVolumeDialog(plugin: MVVMPlugin, audio: AudioDirector): void {
  const music = ref(audio.musicVolume);
  const sfx = ref(audio.sfxVolume);
  const muted = ref(audio.muted);
  let lastPreview = audio.sfxVolume;
  const close = (): void => {
    plugin.modal.closeTop();
  };

  plugin.modal.open(
    () => {
      Panel({ variant: 'surface', radius: 12, padding: 16, width: 316, gap: 12 }, () => {
        Row({ width: 'fill', alignItems: 'center' }, () => {
          Text('音 量', { size: 'lg', name: 'volumeTitle' });
          Spacer({ flex: true });
          Text(() => (muted.value ? '已静音' : '正在播放'), {
            size: 'xs',
            tone: () => (muted.value ? 'danger' : 'muted'),
          });
        });
        Divider({});

        Row({ width: 'fill', alignItems: 'center', gap: 10 }, () => {
          Text('音乐', { size: 'sm', width: 34 });
          Slider({
            value: music,
            min: 0,
            max: 1,
            step: 0.05,
            height: 32,
            grow: 1,
            name: 'musicVolumeSlider',
            label: '音乐音量',
            onValueChange: (value) => {
              audio.musicVolume = value;
            },
          });
          Text(() => `${Math.round(music.value * 100)}%`, { size: 'sm', width: 40, tone: 'muted' });
        });

        Row({ width: 'fill', alignItems: 'center', gap: 10 }, () => {
          Text('音效', { size: 'sm', width: 34 });
          Slider({
            value: sfx,
            min: 0,
            max: 1,
            step: 0.05,
            height: 32,
            grow: 1,
            name: 'sfxVolumeSlider',
            label: '音效音量',
            onValueChange: (value) => {
              audio.sfxVolume = value;
              // Preview on a coarse step only, so dragging is not a machine-gun of clicks.
              if (Math.abs(value - lastPreview) >= 0.15) {
                lastPreview = value;
                audio.play('pick');
              }
            },
          });
          Text(() => `${Math.round(sfx.value * 100)}%`, { size: 'sm', width: 40, tone: 'muted' });
        });

        Row({ width: 'fill', gap: 8, alignItems: 'center' }, () => {
          Button(() => (muted.value ? '取消静音' : '静音'), {
            toggle: true,
            value: muted,
            variant: () => (muted.value ? 'danger' : 'secondary'),
            size: 'sm',
            name: 'muteToggle',
            onValueChange: (on) => {
              audio.muted = on;
            },
          });
          Spacer({ flex: true });
          Button('关闭', {
            variant: 'primary',
            size: 'sm',
            width: 76,
            name: 'volumeClose',
            onClick: close,
          });
        });
      });
    },
    { name: 'volume', scrim: 0.6 },
  );
}

/**
 * The opponent's strength — and 吃子提示, the one board overlay the game offers.
 *
 * Three rows rather than a cycling button: the levels differ in *cost* as well as in strength (a hard
 * reply takes over a second to think), and that is a decision a player should be able to read before
 * making it instead of discovering by tapping four times.
 *
 * The checkbox rides along with the difficulty rather than getting a menu entry of its own, because it
 * is the same kind of decision: how much help do you want. It is a `toggle` button, which is a real
 * checkbox to a screen reader (`aria-checked`) and to `Enter`/`Space`, and the box glyph is drawn by
 * the label the way the difficulty rows already draw their ✓.
 */
export function openDifficultyDialog(
  plugin: MVVMPlugin,
  current: Difficulty,
  onPick: (value: Difficulty) => void,
  hint: { value: boolean; onToggle: (on: boolean) => void },
): void {
  const chosen = ref<Difficulty>(current);
  const captureHint = ref<boolean>(hint.value);
  const close = (): void => {
    plugin.modal.closeTop();
  };

  plugin.modal.open(
    () => {
      Panel({ variant: 'surface', radius: 12, padding: 16, width: 316, gap: 10 }, () => {
        Row({ width: 'fill', alignItems: 'center' }, () => {
          Text('难 度', { size: 'lg', name: 'difficultyTitle' });
          Spacer({ flex: true });
          Text('随时可改，下一手生效', { size: 'xs', tone: 'muted' });
        });
        Divider({});
        Column({ width: 'fill', gap: 6 }, () => {
          for (const level of DIFFICULTIES) {
            const preset = DIFFICULTY[level];
            Button(
              () =>
                `${DIFFICULTY_LABEL[level]}　${preset.worlds} 个世界 · 深度 ${preset.depth}${
                  chosen.value === level ? '　✓' : ''
                }`,
              {
                variant: () => (chosen.value === level ? 'primary' : 'secondary'),
                size: 'sm',
                width: 'fill',
                name: `difficulty_${level}`,
                label: `难度 ${DIFFICULTY_LABEL[level]}`,
                onClick: () => {
                  chosen.value = level;
                  onPick(level);
                },
              },
            );
          }
        });
        Divider({});
        Column({ width: 'fill', gap: 4 }, () => {
          Button(() => `${captureHint.value ? '☑' : '☐'}　吃子提示`, {
            toggle: true,
            value: captureHint,
            variant: () => (captureHint.value ? 'primary' : 'secondary'),
            size: 'sm',
            width: 'fill',
            name: 'captureHintToggle',
            label: '吃子提示',
            // The toggle's own label is the state, so the callback is the only place the setting is
            // written — one writer, and the dialog cannot end up disagreeing with the board.
            onValueChange: (on) => hint.onToggle(on),
          });
          Text('我方受威胁的棋子泛红光，敌方泛绿光（被吃后能立刻吃回来的子不算）', {
            size: 'xs',
            tone: 'muted',
            wrap: true,
          });
        });
        Divider({});
        Row({ width: 'fill', gap: 8, alignItems: 'center' }, () => {
          Text(() => `当前：${DIFFICULTY_LABEL[chosen.value]}`, { size: 'sm', tone: 'muted' });
          Spacer({ flex: true });
          Button('关闭', {
            variant: 'primary',
            size: 'sm',
            width: 76,
            name: 'difficultyClose',
            onClick: close,
          });
        });
      });
    },
    { name: 'difficulty', scrim: 0.6 },
  );
}
