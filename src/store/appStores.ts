import { OptionsStore } from './optionsStore';
import { TextureRegistry } from '../game/assets/textureRegistry';

/**
 * App-level singletons.
 *
 * These live for the whole session, so they must be created OUTSIDE React's
 * render path. Creating them inside a component body would produce a new store on
 * every render and lose persisted state; creating them per-effect would dispose
 * them on a StrictMode remount, which is exactly the bug that broke the texture
 * registry earlier.
 */

export const optionsStoreRef: OptionsStore = new OptionsStore();
export const textureRegistryRef: TextureRegistry = new TextureRegistry();
