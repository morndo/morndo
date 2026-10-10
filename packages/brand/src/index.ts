// @morndo/brand: the paths of the generated brand assets, relative to this package's root.
// A shared, presentation-level kit, not a bounded context (docs/adr/0007-brand-kit-as-shared-presentation-package.md).
// Regenerate with `npm run build -w @morndo/brand`; test/kit.test.ts keeps this index and the files in step.

/** The mark's two colours: black and white. UI colour tokens are in ./tokens.ts (palette "A Ink"). */
export const brandColors = { ink: "#000000", paper: "#ffffff" } as const;

export { cssVar, cssVarName, neutral, themes, tokenRoles, type NeutralStep, type ThemeName, type TokenName } from "./tokens.ts";

export const brandAssets = {
  mark: {
    black: "assets/mark/morndo-mark-black.svg",
    white: "assets/mark/morndo-mark-white.svg",
    currentColor: "assets/mark/morndo-mark-currentcolor.svg",
    black512: "assets/mark/morndo-mark-black-512.png",
    white512: "assets/mark/morndo-mark-white-512.png",
  },
  wordmark: {
    black: "assets/wordmark/morndo-wordmark-black.svg",
    white: "assets/wordmark/morndo-wordmark-white.svg",
    currentColor: "assets/wordmark/morndo-wordmark-currentcolor.svg",
  },
  lockupHorizontal: {
    black: "assets/lockup-horizontal/morndo-lockup-horizontal-black.svg",
    white: "assets/lockup-horizontal/morndo-lockup-horizontal-white.svg",
    currentColor: "assets/lockup-horizontal/morndo-lockup-horizontal-currentcolor.svg",
    black256h: "assets/lockup-horizontal/morndo-lockup-horizontal-black-256h.png",
    white256h: "assets/lockup-horizontal/morndo-lockup-horizontal-white-256h.png",
  },
  lockupStacked: {
    black: "assets/lockup-stacked/morndo-lockup-stacked-black.svg",
    white: "assets/lockup-stacked/morndo-lockup-stacked-white.svg",
    currentColor: "assets/lockup-stacked/morndo-lockup-stacked-currentcolor.svg",
    black512h: "assets/lockup-stacked/morndo-lockup-stacked-black-512h.png",
    white512h: "assets/lockup-stacked/morndo-lockup-stacked-white-512h.png",
  },
  appIcon: {
    svg: "assets/app-icon/morndo-app-icon.svg",
    png1024: "assets/app-icon/morndo-app-icon-1024.png",
    maskableSvg: "assets/app-icon/morndo-app-icon-maskable.svg",
    maskablePng1024: "assets/app-icon/morndo-app-icon-maskable-1024.png",
  },
  /** Exactly the files for the web app's static root; head.html holds the tags to paste. */
  web: {
    faviconIco: "assets/web/favicon.ico",
    faviconSvg: "assets/web/favicon.svg",
    favicon16: "assets/web/favicon-16.png",
    favicon32: "assets/web/favicon-32.png",
    favicon48: "assets/web/favicon-48.png",
    appleTouchIcon: "assets/web/apple-touch-icon.png",
    icon192: "assets/web/icon-192.png",
    icon512: "assets/web/icon-512.png",
    iconMaskable512: "assets/web/icon-maskable-512.png",
    manifest: "assets/web/site.webmanifest",
    head: "assets/web/head.html",
  },
  social: {
    ogSvg: "assets/social/morndo-og-1200x630.svg",
    ogPng: "assets/social/morndo-og-1200x630.png",
  },
  /** Colour tokens as CSS custom properties (light, dark, data-theme); import once per app. */
  tokens: {
    css: "assets/tokens/morndo-tokens.css",
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];

/** Any asset path in the kit. */
export type BrandAssetPath = Leaves<typeof brandAssets>;

// The Node helper brandAssetUrl() lives in ./node.ts ("@morndo/brand/node"), so this entry stays
// safe to import in a browser bundle (test/entry.test.ts).
