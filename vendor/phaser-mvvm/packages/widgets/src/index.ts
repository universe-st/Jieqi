/**
 * `@phaser-mvvm/widgets` — the M4 control library: `Panel`, `Label`, `Button`, `Image`, `Spacer` and
 * `Divider` (M5–M7 add `TextField`, `TextArea`, `ScrollView`, `Repeat` and `Modal`).
 *
 * Everything is drawn procedurally from the active theme (PLAN §4.6, §10.3), so the library needs no
 * art assets: panels and buttons paint with `Graphics` skins, the focus ring is a stroked rounded
 * rect, and texture images are the only widget that reads from the texture manager.
 *
 * Widgets never listen to Phaser input themselves. The input router drives them through
 * `setHovered`/`setPressed` (pointer) and `activate(source)` (pointer, keyboard, gamepad); they repaint
 * whenever a flag changes because `Widget.appearanceChanged()` calls `refreshAppearance()`.
 */

import './augment';

export { Label, type LabelAlign, type LabelOptions, type LabelTone } from './Label';
export { Panel, type PanelOptions, type PanelVariant } from './Panel';
export {
  Button,
  BUTTON_EVENTS,
  type ButtonOptions,
  type ButtonSize,
  type ButtonVariant,
} from './Button';
export { Image, Image as UIImage, type ImageOptions } from './Image';
export { Spacer, type SpacerOptions } from './Spacer';
export {
  VirtualKeyboardWidget,
  type VirtualKeyboardKind,
  type VirtualKeyboardOptions,
  type KeySlot,
  type KeyboardPage,
} from './VirtualKeyboard';
export {
  a11yLabelFor,
  afterTyping,
  CASE_OFF,
  COMMAND_GLYPH,
  describeSlot,
  KEY_GAP,
  KEY_UNIT,
  keyboardRows,
  keyWidth,
  labelFor,
  pageOf,
  pressShift,
  type CaseState,
  type KeyCommand,
} from './keyboard-plan';
export { Divider, type DividerOptions, type DividerOrientation } from './Divider';
export { branch, BranchWidget, type BranchOptions } from './Branch';
export { planBranch, type BranchBuilder, type BranchKey, type BranchPlan } from './branch-plan';
export { TextField, type TextFieldOptions } from './TextField';
export { Slider, SLIDER_EVENTS, type SliderOptions } from './Slider';
export { clampSliderValue, sliderFraction, sliderValueFromPosition } from './slider-geometry';
export { Repeat, DEFAULT_OVERSCAN, repeat, type RepeatOptions } from './Repeat';
export { withListFlow, type ListFlowShorthands } from './list-flow';
export {
  ScrollView,
  MIN_THUMB,
  SCROLL_DRAG_THRESHOLD,
  FLING_MIN_VELOCITY,
  KEY_LINE_STEP,
  scrollView,
  type ScrollDirection,
  type ScrollbarMode,
  type ScrollViewOptions,
  type VirtualScrollTarget,
} from './ScrollView';
export {
  clampZoomOffset,
  pinchDistance,
  pinchMidpoint,
  pinchOffset,
  pinchScale,
  type ZoomPoint,
} from './zoom-plan';
export { TextArea, type TextAreaOptions } from './TextArea';
export {
  TEXT_INPUT_EVENTS,
  TEXT_INPUT_KEYS,
  TextInputBase,
  type TextInputOptions,
  type TextInputWidgetOptions,
} from './TextInputBase';
export {
  DOM_CONTAINER_WARNING,
  DomInputBridge,
  clampSelection,
  clampValue,
  resetBridgeWarning,
  shouldEmitInput,
  type BridgeRect,
  type InputBridgeHandlers,
  type InputBridgeOptions,
} from './input-bridge';

export {
  button,
  divider,
  installWidgetFactories,
  label,
  panel,
  spacer,
  textArea,
  textField,
  uiImage,
  uiRepeat,
  uiScroll,
  widgetFactoriesInstalled,
  WIDGET_FACTORY_KEYS,
} from './factories';

export {
  clearTextMetrics,
  textMetricsOf,
  textMetricsStats,
  type SceneTextMetrics,
  type TextMetricsStats,
} from './text-metrics';

// Pure helpers: they never import Phaser, so they are reusable (and tested) outside a renderer.
export { computeFit, type FitResult, type ImageFit } from './fit';
export { fontSizeOf, glyphPadding, resolveLabelFontSize } from './text-padding';
export {
  BOUNCE_LIMIT,
  BOUNCE_RESISTANCE,
  DELTA_MODE_LINE,
  DELTA_MODE_PAGE,
  DELTA_MODE_PIXEL,
  INERTIA_DECELERATION,
  INERTIA_STOP_VELOCITY,
  LINE_HEIGHT,
  PAGE_LINES,
  SCROLL_EPSILON,
  applyInertia,
  clampOffset,
  extentOfRects,
  isScrollable,
  normalizeWheel,
  planScrollDrag,
  planScrollKey,
  thumbGeometry,
  type InertiaStep,
  type ScrollDragPlan,
  type ScrollKeyStep,
  type ScrollRect,
  type ThumbGeometry,
} from './scroll-plan';
export {
  computeVisibleRange,
  contentExtentOf,
  describeRepeatFlow,
  diffKeys,
  isGridContainerOptions,
  planRepeatUpdate,
  planVirtualWindow,
  resolveRepeatContainer,
  type KeyDiff,
  type RepeatFlow,
  type RepeatUpdatePlan,
  type VirtualWindow,
  type VirtualWindowOptions,
  type VisibleRange,
} from './repeat-plan';
export {
  applyLineLimit,
  ELLIPSIS,
  ellipsizeAlways,
  ellipsizeLine,
  truncateLines,
  type LineLimitOptions,
  type MeasureWidth,
  type TruncateResult,
} from './text-truncate';
export {
  buttonLabel,
  resolveButtonActivation,
  resolveButtonState,
  type ButtonActivationDecision,
  type ButtonActivationInput,
  type ButtonVisualStateInput,
} from './button-state';
export { BLACK, shadeColor, toCssColor, WHITE } from './color';
export { centeredOffset, centeredOffsetOverflow, contentBox } from './geometry';
export {
  buttonSkinStyles,
  buttonTextColor,
  fillBox,
  paintElevation,
  paintFocusRing,
  panelSkinStyles,
  textInputSkinStyles,
} from './appearance';
export { BOX_CONTAINER_KEYS, boxOptionsOf, optionBag, splitWidgetOptions } from './options';

// Text editing primitives: pure functions, shared by the widgets, the bridge and the tests.
export {
  CARET_BLINK_MS,
  DRAG_AUTOSCROLL_MAX_SPEED,
  DRAG_AUTOSCROLL_RAMP,
  LINE_SPACING,
  MIN_CONTENT_WIDTH,
  PASSWORD_MASK,
  caretAtX,
  caretRectOf,
  clampCaret,
  clampScrollY,
  codePointCount,
  computeLineHeight,
  computeScrollX,
  computeScrollY,
  deleteRange,
  displayOffset,
  dragAutoScrollStep,
  edgeOverflow,
  displaySlice,
  displayValue,
  filterNumeric,
  hasSelection,
  heightForRows,
  insertText,
  layoutTextLines,
  lineEndAt,
  lineIndexAt,
  lineStartAt,
  maskValue,
  moveCaret,
  moveCaretVertically,
  positionLines,
  rowsForHeight,
  sanitizeValue,
  selectedText,
  selectionRange,
  selectionRects,
  splitLines,
  stripNewlines,
  valueOffsetFromDisplay,
  visibleTextWindow,
  widestLine,
  wrapLine,
  type CaretPosition,
  type EditResult,
  type LayoutLine,
  type SanitizeOptions,
  type TextInputAlign,
  type TextInputType,
  type TextLayoutOptions,
  type TextLine,
  type TextRange,
  type TextWindow,
} from './text-edit';
