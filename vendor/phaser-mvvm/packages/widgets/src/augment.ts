/**
 * Ambient declarations for the widget factories.
 *
 * This file is a real module (it has an `export {}`) so bundlers can resolve it; the
 * `declare global` block performs the actual declaration merging with Phaser's global namespace, the
 * same way `@phaser-mvvm/phaser` declares `scene.add.vbox(...)` and `scene.mvvm`.
 *
 * `uiLabel` is declared here on purpose: the widget library owns that key from M4 on, replacing the
 * probe widget the adapter shipped while the library did not exist yet.
 */

import type { Widget } from '@phaser-mvvm/phaser';
import type { Button, ButtonOptions } from './Button';
import type { Divider, DividerOptions } from './Divider';
// Aliased: inside `Phaser.GameObjects` the identifier `Image` already means `Phaser.GameObjects.Image`.
import type { Image as UIImage, ImageOptions } from './Image';
import type { Label, LabelOptions } from './Label';
import type { Panel, PanelOptions } from './Panel';
import type { Repeat, RepeatOptions } from './Repeat';
import type { ScrollView, ScrollViewOptions } from './ScrollView';
import type { Slider, SliderOptions } from './Slider';
import type { Spacer, SpacerOptions } from './Spacer';
import type { TextArea, TextAreaOptions } from './TextArea';
import type { TextField, TextFieldOptions } from './TextField';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Phaser {
    namespace GameObjects {
      interface GameObjectFactory {
        /** Creates a text label widget and adds it to the Scene. */
        uiLabel(options?: LabelOptions, children?: Widget[]): Label;
        /** Creates a panel widget (a themed box container) and adds it to the Scene. */
        uiPanel(options?: PanelOptions, children?: Widget[]): Panel;
        /** Creates a button widget and adds it to the Scene. */
        uiButton(options?: ButtonOptions, children?: Widget[]): Button;
        /** Creates a texture image widget and adds it to the Scene. */
        uiImage(options: ImageOptions, children?: Widget[]): UIImage;
        /** Creates a layout spacer widget and adds it to the Scene. */
        /** Creates a slider widget and adds it to the Scene. */
        uiSlider(options?: SliderOptions, children?: Widget[]): Slider;
        uiSpacer(options?: SpacerOptions, children?: Widget[]): Spacer;
        /** Creates a divider widget and adds it to the Scene. */
        uiDivider(options?: DividerOptions, children?: Widget[]): Divider;
        /** Creates a single-line text input widget and adds it to the Scene. */
        uiTextField(options?: TextFieldOptions, children?: Widget[]): TextField;
        /** Creates a multi-line text input widget and adds it to the Scene. */
        uiTextArea(options?: TextAreaOptions, children?: Widget[]): TextArea;
        /** Creates a keyed, optionally virtualised list widget and adds it to the Scene. */
        uiRepeat<Item>(options: RepeatOptions<Item>): Repeat<Item>;
        /** Creates a clipped scroll viewport and adds it to the Scene. */
        uiScroll(options?: ScrollViewOptions, children?: Widget[]): ScrollView;
      }
    }
  }
}

export {};
