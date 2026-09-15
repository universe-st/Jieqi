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
  Scroll,
  Slider,
  Spacer,
  Text,
} from '@phaser-mvvm/widgets/compose';

import { DIFFICULTY, type Difficulty } from '../ai';
import type { AudioDirector } from '../audio/AudioDirector';
import { MODE_NAME, type GameMode } from '../core/types';
import { DIFFICULTY_LABEL } from '../vm/GameViewModel';
import { DIFFICULTIES } from '../vm/prefs';

/** The ways to play, in the order the dialog lists them. */
export const MODES: readonly GameMode[] = ['standard', 'mixed', 'fog'];

/**
 * One line per mode, under its button.
 *
 * Written for someone who has played 揭棋 before and has never seen 混斗 or 迷雾: the first says what
 * does *not* change (you only ever turn over your own pieces), the second is the whole rule in one
 * sentence — whose piece a 暗子 is comes down to which half it stands on, and the coin can land on the
 * opponent's face — and the third is the vision/fog rule: you see what your pieces see, and a file
 * swallowed by fog is not a 将帅碰头.
 */
export const MODE_HINT: Readonly<Record<GameMode, string>> = {
  standard: '双方各执十五枚暗子：翻开的永远是自己人，暗子只知道格位、不知道身份。',
  mixed: '红黑三十枚棋子混洗后背面朝上：己方半场的暗子暂时归你，翻开若是敌方棋子，该子当场易主。',
  fog: '标准玩法 + 视野：只能看到己方棋子能看见的格子，其余被迷雾覆盖；迷雾挡住将帅碰头。',
};

/**
 * 玩法介绍 (the board's ？ button) — each mode's full rules, one line per rule.
 *
 * Written as the mode itself would explain them: what the deal looks like, how a 暗子 behaves, how
 * the game is won, and the one or two rules that are specific to the mode. The 迷雾 text carries the
 * 一骑讨 and the 仅剩将帅判和 rules (both user-定稿, 2026-09-15) because those are the two things a
 * fog player must know that the fog itself will not tell them.
 */
export const MODE_RULES: Readonly<Record<GameMode, readonly string[]>> = {
  standard: [
    '开局：双方十六枚棋子按象棋摆好，将帅明面，其余十五枚各自打乱、背面朝上摆在自己半场。',
    '暗子按所在格的棋走：落子时翻开，翻开的永远是自己人。',
    '暗子被吃时背面朝上离盘——只有吃子方看到它是什么，被吃方永远不知道自己的暗子是什么。',
    '翻开的子按真身走法；翻开的仕相可以出九宫、过河。',
    '送将会让己方将帅暴露在攻击之下，属非法着法，不能走。',
    '将死、困毙均判负；同一局面第三次重现被禁止（禁止循环追棋，被将军时豁免）。',
    '久无吃子判和；认输判负。',
  ],
  mixed: [
    '开局：红黑三十枚非将帅棋子混洗成一副，背面朝上摆满双方半场；将帅仍明面。',
    '暗子归所在半场所有：你半场的暗子暂时归你，可以走、可以吃。',
    '暗子落子时翻开：是自己的棋就继续用；若是敌方棋子，当场易主变成对方的子。',
    '翻开的仕相可以出九宫、过河。',
    '禁止立即吃将：对方刚翻出的子，这一手不能直接吃将。',
    '送将非法、将死困毙判负、禁止循环追棋、久无吃子判和——同标准玩法。',
  ],
  fog: [
    '标准玩法 + 迷雾：你只能看到己方棋子看得见的地方——棋子自身、周围八格、一步能走到之处。',
    '看不见的棋子不会画出来；被迷雾盖住的格子是你的盲区。',
    '迷雾 = 吃王棋：只有吃掉对方将帅才赢。送将合法，将死、困毙不判负。',
    '将军提示只在你看得见将军的棋时出现。',
    '一骑讨：视野里有对方将帅、且双方将帅同在一条竖线、中间没有看得见的棋子阻挡时，选中己方将帅、点击对方将帅发起对决——连线亮出后，线上确实无子则直取敌帅获胜；线上藏着暗子则己方将帅阵亡判负。',
    '双方仅剩将帅时判和；久无吃子判和。',
    '电脑同样受迷雾限制，会按「上次看见」的位置追踪你的将帅。',
  ],
};

/**
 * 玩法介绍 — the ？ button's dialog: the current mode's full rules in a scrollable panel.
 *
 * One dialog for all three modes, showing whichever the match was dealt as: the board already knows
 * what the player is playing, and asking again would be a control nobody needs.
 */
export function openModeHelpDialog(plugin: MVVMPlugin, mode: GameMode): void {
  plugin.modal.open(
    () => {
      Panel({ variant: 'surface', radius: 12, padding: 16, width: 316, gap: 10 }, () => {
        Row({ width: 'fill', alignItems: 'center' }, () => {
          Text(`玩法介绍 · ${MODE_NAME[mode]}`, { size: 'lg', name: 'helpTitle' });
          Spacer({ flex: true });
        });
        Divider({});
        Scroll({ direction: 'vertical', width: 'fill', height: 400, name: 'helpScroll' }, () => {
          Column({ width: 'fill', gap: 6, padding: { right: 4 } }, () => {
            for (const line of MODE_RULES[mode]) {
              Text(line, { size: 'xs', tone: 'muted', wrap: true });
            }
          });
        });
        Divider({});
        Row({ width: 'fill', justifyContent: 'end' }, () => {
          Button('关闭', {
            variant: 'primary',
            size: 'sm',
            width: 76,
            name: 'helpClose',
            onClick: () => plugin.modal.closeTop(),
          });
        });
      });
    },
    { name: 'help', scrim: 0.6 },
  );
}

/**
 * 玩法选择 — the dialog 开始游戏 opens.
 *
 * It sits on the way in rather than in a settings screen because the mode is not a preference like the
 * volume: it decides what the deal *is*, so it can only be asked before a board exists. Picking one
 * starts the match in the same tap (the caller hands over to 定先后), and the choice is remembered for
 * next time — a player who wants 混斗 wants it every game, and one who does not should never see it
 * again by accident.
 */
export function openModeDialog(
  plugin: MVVMPlugin,
  current: GameMode,
  onPick: (mode: GameMode) => void,
): void {
  const chosen = ref<GameMode>(current);

  plugin.modal.open(
    () => {
      Panel({ variant: 'surface', radius: 12, padding: 16, width: 316, gap: 10 }, () => {
        Row({ width: 'fill', alignItems: 'center' }, () => {
          Text('玩 法', { size: 'lg', name: 'modeTitle' });
          Spacer({ flex: true });
          Text('选定后开局', { size: 'xs', tone: 'muted' });
        });
        Divider({});
        Column({ width: 'fill', gap: 10 }, () => {
          for (const mode of MODES) {
            Column({ width: 'fill', gap: 3 }, () => {
              Button(() => `${MODE_NAME[mode]}${chosen.value === mode ? '　✓' : ''}`, {
                variant: () => (chosen.value === mode ? 'primary' : 'secondary'),
                size: 'md',
                width: 'fill',
                name: `mode_${mode}`,
                label: MODE_NAME[mode],
                onClick: () => {
                  chosen.value = mode;
                  plugin.modal.closeTop();
                  onPick(mode);
                },
              });
              Text(MODE_HINT[mode], { size: 'xs', tone: 'muted', wrap: true });
            });
          }
        });
        Divider({});
        Row({ width: 'fill', gap: 8, alignItems: 'center' }, () => {
          Text(() => `上次选择：${MODE_NAME[chosen.value]}`, { size: 'xs', tone: 'muted' });
          Spacer({ flex: true });
          Button('取消', {
            variant: 'ghost',
            size: 'sm',
            width: 76,
            name: 'modeCancel',
            onClick: () => plugin.modal.closeTop(),
          });
        });
      });
    },
    { name: 'mode', scrim: 0.6 },
  );
}

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
