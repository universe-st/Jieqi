/**
 * Theme tokens and the theme registry.
 *
 * Widgets never hard-code colours, sizes or radii: they read `getTheme()` while painting and
 * subscribe with `onThemeChange()` so a theme switch repaints only what is on screen. The two
 * built-in themes (`dark`, `light`) follow the semantic naming in ADR-0008's sibling decisions
 * (PLAN §4.6): a widget asks for `primary` / `surface` / `textMuted`, never for a literal hex.
 */

export type ThemeName = 'dark' | 'light';

export type ThemeColorName =
  | 'background'
  | 'surface'
  | 'surfaceAlt'
  | 'surfaceHover'
  | 'overlay'
  | 'primary'
  | 'primaryHover'
  | 'primaryPressed'
  | 'onPrimary'
  | 'text'
  | 'textMuted'
  | 'textDisabled'
  | 'border'
  | 'borderStrong'
  | 'danger'
  | 'success'
  | 'warning'
  | 'focusRing';

export type ThemeSizeName = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface Theme {
  name: ThemeName | string;
  colors: Record<ThemeColorName, number>;
  fontFamily: string;
  fontSize: Record<ThemeSizeName, number>;
  spacing: Record<ThemeSizeName, number>;
  radius: { sm: number; md: number; lg: number; pill: number };
  controlHeight: { sm: number; md: number; lg: number };
  borderWidth: number;
  focusRingWidth: number;
  /**
   * Motion durations in milliseconds, named after what they are *for* rather than how fast they feel.
   *
   * The transition system reads these as its defaults (`DEFAULT_ENTER`/`DEFAULT_EXIT` keep the shape —
   * easing, endpoints — while the duration comes from here), so a project retunes every dialog and page
   * transition in one place instead of hunting for `duration:` in call sites. An explicit duration in
   * `MVVMPlugin.configure({ transition: … })`, in a per-dialog/per-page option or in a `TransitionSpec`
   * still wins; a spec that only states an easing keeps the token.
   *
   * Both built-in themes carry the same numbers on purpose: motion is a property of the design system,
   * not of the palette — but a theme is allowed to differ (a "reduced motion" theme is the obvious
   * case), and `setTheme()` takes a whole `Theme` object, so an app can supply its own.
   */
  motion: { enter: number; exit: number };
}

export const DARK_THEME: Theme = {
  name: 'dark',
  colors: {
    background: 0x0d1117,
    surface: 0x161b22,
    surfaceAlt: 0x1f2630,
    surfaceHover: 0x222b36,
    overlay: 0x000000,
    primary: 0x2f6feb,
    primaryHover: 0x3b7cf5,
    primaryPressed: 0x2559c9,
    onPrimary: 0xffffff,
    text: 0xe6edf3,
    textMuted: 0x8b949e,
    textDisabled: 0x5b6470,
    border: 0x30363d,
    borderStrong: 0x484f58,
    danger: 0xf85149,
    success: 0x3fb950,
    warning: 0xd29922,
    focusRing: 0x58a6ff,
  },
  fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif',
  fontSize: { xs: 12, sm: 14, md: 16, lg: 20, xl: 26 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  controlHeight: { sm: 28, md: 36, lg: 44 },
  borderWidth: 1,
  focusRingWidth: 2,
  motion: { enter: 160, exit: 120 },
};

export const LIGHT_THEME: Theme = {
  name: 'light',
  colors: {
    background: 0xf6f8fa,
    surface: 0xffffff,
    surfaceAlt: 0xeef1f4,
    surfaceHover: 0xe7ebef,
    overlay: 0x1f2328,
    primary: 0x0969da,
    primaryHover: 0x1a7fef,
    primaryPressed: 0x0757b8,
    onPrimary: 0xffffff,
    text: 0x1f2328,
    textMuted: 0x59636e,
    textDisabled: 0x8c959f,
    border: 0xd0d7de,
    borderStrong: 0xafb8c1,
    danger: 0xcf222e,
    success: 0x1a7f37,
    warning: 0x9a6700,
    focusRing: 0x0969da,
  },
  fontFamily: DARK_THEME.fontFamily,
  fontSize: DARK_THEME.fontSize,
  spacing: DARK_THEME.spacing,
  radius: DARK_THEME.radius,
  controlHeight: DARK_THEME.controlHeight,
  borderWidth: DARK_THEME.borderWidth,
  focusRingWidth: DARK_THEME.focusRingWidth,
  motion: DARK_THEME.motion,
};

export const BUILT_IN_THEMES: Record<ThemeName, Theme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
};

let current: Theme = DARK_THEME;
const listeners = new Set<(theme: Theme) => void>();

/** The theme widgets paint with. */
export function getTheme(): Theme {
  return current;
}

/** Switches the active theme and notifies subscribers (widgets repaint themselves). */
export function setTheme(theme: ThemeName | Theme): Theme {
  const next = typeof theme === 'string' ? BUILT_IN_THEMES[theme] : theme;
  if (!next) {
    throw new Error(`setTheme: unknown theme "${String(theme)}"`);
  }
  if (next === current) {
    return current;
  }
  current = next;
  for (const listener of Array.from(listeners)) {
    listener(current);
  }
  return current;
}

/** Subscribes to theme changes; returns an unsubscribe function. */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Number of registered listeners (leak assertions in tests and dev tooling). */
export function themeListenerCount(): number {
  return listeners.size;
}
