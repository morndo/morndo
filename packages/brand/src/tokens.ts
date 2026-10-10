// Morndo colour tokens: palette "A Ink" (picked by the owner, 2026-10-01). Monochrome; colour is
// only for status. The values come from the product lane's palette tool (OKLCH ramps, checked
// against WCAG 2.2 and APCA); test/tokens.test.ts re-checks every pair here, and scripts/build.ts
// writes assets/tokens/morndo-tokens.css from this file. Rules and research: COLOR.md.

/** The neutral ramp: warm at the light end (morning paper), cool at the dark end (night ink). */
export const neutral = {
  50: "#fcfaf5",
  100: "#f5f3f0",
  200: "#e8e6e4",
  300: "#d5d5d4",
  400: "#a7a7a8",
  500: "#7c7d7f",
  600: "#5c5d61",
  700: "#45464b",
  800: "#2c2e33",
  900: "#181a20",
  950: "#0a0d13",
} as const;

/** Semantic tokens per theme. Same keys in both themes. */
export const themes = {
  light: {
    bg: "#fbf9f4",
    surface: "#ffffff",
    raised: "#ffffff",
    divider: "#e2dfda",
    border: "#82807c",
    text: "#1b1813",
    textMuted: "#66635d",
    placeholder: "#76726c",
    ink: "#1b1813",
    inkFg: "#ffffff",
    inkHover: "#37342f",
    accent: "#1b1813",
    accentFg: "#ffffff",
    link: "#1b1813",
    hover: "#1b18130d",
    fill: "#eceae4",
    selection: "#e5e3de",
    focus: "#1b1813",
    success: "#008779",
    successText: "#006a5e",
    successSubtle: "#eafcf8",
    warning: "#ca7400",
    warningText: "#915100",
    warningSubtle: "#fff6ee",
    danger: "#af283d",
    dangerText: "#97042a",
    dangerSubtle: "#fff5f4",
  },
  dark: {
    bg: "#0d0f16",
    surface: "#14171e",
    raised: "#1c1f26",
    divider: "#2c2f36",
    border: "#979ba4",
    text: "#e7e9ef",
    textMuted: "#cdd0d8",
    placeholder: "#9b9ea7",
    ink: "#e7e9ef",
    inkFg: "#0d0f16",
    inkHover: "#ced0d6",
    accent: "#e7e9ef",
    accentFg: "#0d0f16",
    link: "#e7e9ef",
    hover: "#e7e9ef0f",
    fill: "#22242b",
    selection: "#292c33",
    focus: "#e7e9ef",
    success: "#3dc8b5",
    successText: "#97eadc",
    successSubtle: "#0a2723",
    warning: "#ffd1a9",
    warningText: "#ffe2ca",
    warningSubtle: "#311c08",
    danger: "#f46974",
    dangerText: "#ffc2c3",
    dangerSubtle: "#361618",
  },
} as const;

export type ThemeName = keyof typeof themes;
export type TokenName = keyof (typeof themes)["light"];
export type NeutralStep = keyof typeof neutral;

/** What each token is for (also written into the CSS as comments). */
export const tokenRoles: Record<TokenName, string> = {
  bg: "page background",
  surface: "cards, panels, inputs",
  raised: "menus and popovers (white with a shadow in light)",
  divider: "decorative rules between rows and sections (no contrast requirement)",
  border: "boundaries that identify a control: inputs, checkboxes (3:1)",
  text: "body text",
  textMuted: "secondary text, metadata",
  placeholder: "input placeholder",
  ink: "primary button fill, badges",
  inkFg: "text on ink",
  inkHover: "primary button on hover: ink mixed toward the page",
  accent: "alias of ink: Ink has no colour accent",
  accentFg: "alias of inkFg",
  link: "links (ink, underlined)",
  hover: "row or item under the pointer: a state layer (the text colour at 5% light, 6% dark) that shows on bg, surface and raised; text on it is --morndo-text",
  fill: "quiet fill: tags, code, chips (text on it is --morndo-text)",
  selection: "selected row or item, with a 3px ink bar as the state cue (text on it is --morndo-text)",
  focus: "focus ring: 2px solid, 2px offset",
  success: "status indicator (icon, dot)",
  successText: "status written in colour",
  successSubtle: "status banner or chip background",
  warning: "status indicator (icon, dot)",
  warningText: "status written in colour",
  warningSubtle: "status banner or chip background",
  danger: "status indicator (icon, dot)",
  dangerText: "status written in colour",
  dangerSubtle: "status banner or chip background",
};

/** The CSS custom property name of a token, e.g. textMuted -> --morndo-text-muted. */
export const cssVarName = (token: TokenName | `neutral-${NeutralStep}`): string =>
  `--morndo-${token.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;

/** A CSS var() reference to a token, e.g. cssVar("text") -> "var(--morndo-text)". */
export const cssVar = (token: TokenName | `neutral-${NeutralStep}`): string => `var(${cssVarName(token)})`;
