/**
 * `this.add.*` integration.
 *
 * Phaser's Game Object Factory lets game objects inject their own creation methods. phaser-mvvm
 * registers widget factories under names that do not collide with Phaser's built-ins (`grid` is
 * already taken by Phaser's debug Grid game object, hence `uiGrid`).
 *
 * The ambient declarations in `augment.ts` make these methods type-safe on `scene.add`.
 */

import Phaser from 'phaser';
import {
  AbsoluteWidget,
  BoxWidget,
  type AbsoluteWidgetOptions,
  type BoxWidgetOptions,
  type GridWidgetOptions,
  GridWidget,
  type StackWidgetOptions,
  StackWidget,
} from './LayoutWidget';
import type { Widget } from './Widget';
import { RectWidget, type RectWidgetOptions } from './widgets';

interface FactoryInternals {
  scene: Phaser.Scene;
  displayList: { add<T>(child: T): T };
}

type RegisterFn = (this: unknown, ...args: unknown[]) => unknown;
type FactoryRegistry = { register(key: string, fn: RegisterFn): void };

let installed = false;

function internalsOf(factory: unknown): FactoryInternals {
  return factory as FactoryInternals;
}

/** Registers every phaser-mvvm widget factory. Idempotent; safe to call from a module top level. */
export function installFactories(): void {
  if (installed) {
    return;
  }
  installed = true;

  const registry = Phaser.GameObjects.GameObjectFactory as unknown as FactoryRegistry;

  registry.register('vbox', function (this: unknown, options, children) {
    const factory = internalsOf(this);
    return factory.displayList.add(
      new BoxWidget(
        factory.scene,
        { ...((options as BoxWidgetOptions) ?? {}), direction: 'vertical' },
        (children as Widget[]) ?? [],
      ),
    );
  });

  registry.register('hbox', function (this: unknown, options, children) {
    const factory = internalsOf(this);
    return factory.displayList.add(
      new BoxWidget(
        factory.scene,
        { ...((options as BoxWidgetOptions) ?? {}), direction: 'horizontal' },
        (children as Widget[]) ?? [],
      ),
    );
  });

  registry.register('uiGrid', function (this: unknown, options, children) {
    const factory = internalsOf(this);
    return factory.displayList.add(
      new GridWidget(
        factory.scene,
        (options as GridWidgetOptions) ?? {},
        (children as Widget[]) ?? [],
      ),
    );
  });

  registry.register('uiStack', function (this: unknown, options, children) {
    const factory = internalsOf(this);
    return factory.displayList.add(
      new StackWidget(
        factory.scene,
        (options as StackWidgetOptions) ?? {},
        (children as Widget[]) ?? [],
      ),
    );
  });

  registry.register('uiAbsolute', function (this: unknown, options, children) {
    const factory = internalsOf(this);
    return factory.displayList.add(
      new AbsoluteWidget(
        factory.scene,
        (options as AbsoluteWidgetOptions) ?? {},
        (children as Widget[]) ?? [],
      ),
    );
  });

  registry.register('uiRect', function (this: unknown, options) {
    const factory = internalsOf(this);
    return factory.displayList.add(
      new RectWidget(factory.scene, (options as RectWidgetOptions) ?? {}),
    );
  });

  // `uiLabel` is owned by `@phaser-mvvm/widgets`: its `Label` supersedes the probe widget that ships
  // with this package, and `installWidgetFactories()` registers it. Registering it here as well would
  // make the factory key order-dependent.
}

/** Factory keys registered by this package (useful in tests and docs). */
export const FACTORY_KEYS = ['vbox', 'hbox', 'uiGrid', 'uiStack', 'uiAbsolute', 'uiRect'] as const;

/** True when `installFactories()` has run in this process. */
export function factoriesInstalled(): boolean {
  return installed;
}
