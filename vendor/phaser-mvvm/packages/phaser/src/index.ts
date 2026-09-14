/**
 * `@phaser-mvvm/phaser` — the Phaser 4 adapter.
 *
 * This is the only package in the monorepo allowed to import Phaser (ADR-0005): everything that
 * touches the renderer, the scene lifecycle or the input system lives here, so a Phaser 4.x API
 * change is contained to one package.
 */

import './augment';

export {
  Widget,
  WIDGET_EVENTS,
  type ActivationSource,
  type FocusTarget,
  type PointerChainOptionHooks,
  type WidgetOptions,
} from './Widget';
export {
  claimPointerDrag,
  clearPointerClaims,
  pointerClaims,
  pointerDragOwner,
  releasePointerDrag,
  type PointerClaimOwner,
} from './pointer-claim';
export {
  AbsoluteWidget,
  type AbsoluteWidgetOptions,
  BoxWidget,
  type BoxWidgetOptions,
  GridWidget,
  type GridWidgetOptions,
  hbox,
  grid,
  absolute,
  splitOptions,
  stack,
  StackWidget,
  type StackWidgetOptions,
  vbox,
} from './LayoutWidget';
export { UIRoot, type UIRootOptions } from './UIRoot';
export {
  buildUiSubtree,
  currentUiScene,
  currentUiScope,
  emitWidget,
  inUiScope,
  runInUiScope,
  uiScopeDepth,
  withUiParent,
  type UiScopeFrame,
  type UiScopeResult,
} from './uiscope';
export { MVVMPlugin } from './plugin';
export { mergePluginConfig, type MVVMPluginConfig } from './plugin-config';
export {
  A11Y_ATTRIBUTE,
  A11Y_LIVE_ATTRIBUTE,
  A11yBridge,
  VALUE_RANGE_ROLES,
  a11yAttributes,
  a11yText,
  describeA11yText,
  type A11yDescription,
  type A11yDescriptor,
  type A11yOptions,
} from './a11y';
export { buildUiPage, type BuiltUi } from './ui-build';
export {
  NO_SAFE_AREA,
  SAFE_AREA_MAX_FRACTION,
  clampSafeArea,
  cssInsetsToDesign,
  insetsInsideCanvas,
  isZeroSafeArea,
  readSafeAreaInsets,
  type CanvasBox,
  type SafeAreaInsets,
} from './safe-area';
export { UIScene, type UISceneBackHook } from './UIScene';
export { requireMVVMPlugin } from './require-plugin';
export {
  DEFAULT_REVEAL_MARGIN,
  DEFAULT_REVEAL_PASSES,
  contentRectOf,
  revealInViewports,
  revealOffset,
  type ContentRectSource,
  type RevealAxis,
  type RevealHost,
  type RevealOptions,
} from './reveal';
export { PageHost, type PageBackTarget, type PageHandle, type PageOptions } from './pages';
export { Router, type RouteOptions, type RouteVisit } from './router';
export {
  UnknownRouteError,
  matchRoute,
  normalizeRoutePath,
  routeNames,
  routeParams,
  type RouteBuilder,
  type RouteMatch,
  type RouteParams,
  type RouteTable,
} from './route-plan';
export {
  DEFAULT_ENTER,
  DEFAULT_EXIT,
  DEFAULT_TRANSITION_OPTIONS,
  EASINGS,
  INSTANT,
  TransitionRunner,
  easingOf,
  prefersReducedMotion,
  progressOf,
  resolveTransition,
  resolveTransitions,
  type Easing,
  type EasingName,
  type Endpoint,
  type ResolvedTransition,
  type ResolvedTransitions,
  type TransitionInput,
  type TransitionOptions,
  type TransitionOverride,
  type TransitionProp,
  type TransitionRun,
  type TransitionSpec,
  type TransitionTarget,
} from './transition';
export {
  BOX_KEYS,
  CONTAINER_OPTION_KEYS,
  GRID_KEYS,
  STACK_KEYS,
  runtimeOptionTarget,
  type RuntimeOptionTarget,
} from './container-options';
export { planBack, type BackState } from './back-plan';
export { factoriesInstalled, FACTORY_KEYS, installFactories } from './factory';
export {
  LabelWidget,
  type LabelWidgetOptions,
  RectWidget,
  type RectWidgetOptions,
} from './widgets';
export {
  DARK_THEME,
  LIGHT_THEME,
  BUILT_IN_THEMES,
  getTheme,
  setTheme,
  onThemeChange,
  themeListenerCount,
  type Theme,
  type ThemeColorName,
  type ThemeName,
  type ThemeSizeName,
} from './theme';
export {
  ProceduralSkin,
  DEFAULT_PRIMARY_SKIN,
  DEFAULT_SURFACE_SKIN,
  colorOf,
  type BackgroundStyle,
  type Skin,
  type SkinStyles,
} from './skin';
export { resolveWidgetState, type WidgetState, type WidgetStateFlags } from './widget-state';
export {
  BASE_WIDGET_OPTION_KEYS,
  reportUnknownOptions,
  suggestOptionKey,
  unknownOptionKeys,
} from './option-keys';
export {
  LruCache,
  PhaserTextMeasurer,
  textMeasureKey,
  type MeasuredText,
  type TextMeasureRequest,
  type TextMeasurer,
} from './measurer';
export {
  FocusManager,
  collectFocusable,
  directionalTolerance,
  isFocusNodeLike,
  pickDirectional,
  stageRectOf,
  stageRectsOf,
  type AnchorLike,
  type FocusManagerOptions,
  type FocusNodeLike,
  type FocusScopeOptions,
  type RectSourceLike,
} from './focus';
export { ModalHost, type ModalCloseReason, type ModalHandle, type ModalOptions } from './modal';
export {
  InputRouter,
  shouldFocusOnPress,
  DEFAULT_DRAG_THRESHOLD,
  collectInteractive,
  diffInteractionState,
  isClickGesture,
  pointerInWidgetSpace,
  resolveTargetInTree,
  isWithinTree,
  type ContainerLike,
  type InputRouterOptions,
  type PointLike,
  type TargetNode,
} from './input';
export {
  PointerChainHub,
  chainLabelOf,
  type ChainPoint,
  type PointerChainAction,
  type PointerChainEntry,
  type PointerChainEvent,
  type PointerChainInput,
  type PointerChainNode,
  type PointerChainStop,
  type PointerChainTrace,
  type PointerKind,
  type PointerPhase,
  type RetainedPointerChain,
} from './pointer-chain';
export {
  ARROW_KEY_OF_DIRECTION,
  NAV_DIRECTIONS,
  NAV_REPEAT_DEFAULTS,
  NavRepeat,
  NavSourceRegistry,
  gamepadActionsOf,
  gamepadStateOf,
  heldDirectionsOf,
  keyboardActionOf,
  GAMEPAD_AXIS_THRESHOLD,
  GAMEPAD_BUTTON_ACTIVATE,
  GAMEPAD_BUTTON_BACK,
  type NavAction,
  type NavDirection,
  type NavInputState,
  type NavRepeatOptions,
  type NavSource,
  type NavSourceHost,
} from './nav';
export { GamepadNavSource, KeyboardNavSource } from './nav-sources';
export {
  MODEL_CHANGE_EVENT,
  bindCommand,
  bindEnabled,
  bindError,
  bindModel,
  bindBooleanModel,
  bindNumberModel,
  bindValueModel,
  bindPath,
  bindTemplate,
  bindTemplateText,
  bindText,
  bindValue,
  bindVisible,
  bindingScopeOf,
  templateScopeOf,
  type BindingFlush,
  type BindingOptions,
  type BindingTarget,
  type CommandBindingOptions,
  type CommandGetter,
  type ModelBindingHost,
  type BooleanModelHost,
  type NumberModelHost,
  type ValueModelHost,
  type PathCommandBindingOptions,
  type StopBinding,
} from './binding';

// Re-exported so application code only needs one import for layout params and types.
export * from '@phaser-mvvm/layout';
