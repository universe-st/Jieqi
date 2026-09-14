/**
 * The phaser-mvvm theme.
 *
 * phaser-mvvm widgets paint themselves exclusively from theme tokens, so a whole reskin is one
 * `setTheme()` call — and the HUD follows the 古风 palette without a single hard-coded colour in the
 * view code.
 */

import { DARK_THEME, type Theme } from '@phaser-mvvm/phaser';
import { C, SERIF_STACK } from './palette';

export const JIEQI_THEME: Theme = {
  ...DARK_THEME,
  name: 'jieqi',
  colors: {
    /* 桌面：深色紫檀 */
    background: C.backdrop,
    surface: C.woodDeep,
    surfaceAlt: C.wood,
    surfaceHover: C.woodLight,
    overlay: 0x120b08,

    /* 主色：青玉 —— 与朱砂红的 danger 明确区分，否则「新局」和「认输」长得一模一样 */
    primary: 0x3f7d55,
    primaryHover: 0x4d9668,
    primaryPressed: 0x2f5f40,
    onPrimary: 0xf2f7ee,

    /* 文字：宣纸色 */
    text: 0xefe2c3,
    textMuted: 0xa8926a,
    textDisabled: 0x6d5c46,

    border: 0x7a5836,
    borderStrong: C.goldDim,

    danger: C.danger,
    success: C.jade,
    warning: 0xd4a017,
    focusRing: C.goldBright,
  },
  fontFamily: SERIF_STACK,
  fontSize: { xs: 12, sm: 14, md: 16, lg: 20, xl: 26 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 3, md: 6, lg: 10, pill: 999 },
  controlHeight: { sm: 30, md: 38, lg: 46 },
  borderWidth: 1,
  focusRingWidth: 2,
  // Slightly slower than the framework default: 古风 UI reads as considered, not snappy.
  motion: { enter: 200, exit: 150 },
};
