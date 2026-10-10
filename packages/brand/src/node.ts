// Node-only helper of @morndo/brand, imported as "@morndo/brand/node": file URLs of the assets.
// It is kept out of the main entry because a template-literal new URL(..., import.meta.url) makes
// Vite glob the whole package folder into a browser bundle (https://vite.dev/guide/assets).
import type { BrandAssetPath } from "./index.ts";

/** The file URL of an asset, for Node scripts and build steps. */
export const brandAssetUrl = (path: BrandAssetPath): URL => new URL(`../${path}`, import.meta.url);
