/**
 * Ambient declarations that make phaser-mvvm's integration points type-safe:
 * `scene.add.vbox(...)` and `scene.mvvm`.
 *
 * This file is a real module (it has an `export {}`) so bundlers can resolve it; the
 * `declare global` block performs the actual declaration merging with Phaser's global namespace.
 */

import type { MVVMPlugin } from './plugin';
import type {
  AbsoluteWidget,
  AbsoluteWidgetOptions,
  BoxWidget,
  BoxWidgetOptions,
  GridWidget,
  GridWidgetOptions,
  StackWidget,
  StackWidgetOptions,
} from './LayoutWidget';
import type { Widget } from './Widget';
import type { RectWidget, RectWidgetOptions } from './widgets';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Phaser {
    namespace GameObjects {
      interface GameObjectFactory {
        /** Creates a vertical box layout widget and adds it to the Scene. */
        vbox(options?: BoxWidgetOptions, children?: Widget[]): BoxWidget;
        /** Creates a horizontal box layout widget and adds it to the Scene. */
        hbox(options?: BoxWidgetOptions, children?: Widget[]): BoxWidget;
        /** Creates a grid layout widget and adds it to the Scene. */
        uiGrid(options?: GridWidgetOptions, children?: Widget[]): GridWidget;
        /** Creates a stacking layout widget and adds it to the Scene. */
        uiStack(options?: StackWidgetOptions, children?: Widget[]): StackWidget;
        /** Creates an absolutely positioned container and adds it to the Scene. */
        uiAbsolute(options?: AbsoluteWidgetOptions, children?: Widget[]): AbsoluteWidget;
        /** Creates a solid rectangle widget and adds it to the Scene. */
        uiRect(options?: RectWidgetOptions): RectWidget;
      }
    }

    interface Scene {
      /** The phaser-mvvm scene plugin, installed via the Game Config `plugins.scene` entry. */
      mvvm: MVVMPlugin;
    }
  }
}

export {};
