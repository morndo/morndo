// A stand-in for SvelteKit's $app/navigation in the browser tests (harness.ts): Phone.svelte calls goto and pushState,
// which only SvelteKit's router provides. goto records where the app asked to go and goes nowhere. pushState and
// replaceState number the history entry the way Kit 2.70.3's shallow routing does (client.js): every entry the router
// owns carries "sveltekit:history", its number, and the state under "sveltekit:states", composed over what history
// already holds. The initial entry is numbered at start, as Kit's start() does.
import { page, type PageState } from "./app-state.stub.svelte.ts";

export function beforeNavigate(_fn: (nav: { type: string; cancel: () => void }) => void): void {}

export async function goto(url: string | URL): Promise<void> {
  const g = globalThis as unknown as { __goto?: string[] };
  (g.__goto ??= []).push(String(url));
}

const HISTORY_INDEX = "sveltekit:history";
let index = 0;

function compose(state: PageState): Record<string, unknown> {
  return { ...(history.state ?? {}), [HISTORY_INDEX]: index, "sveltekit:navigation": 0, "sveltekit:pageurl": location.href, "sveltekit:states": state };
}

if (typeof history !== "undefined" && typeof history.replaceState === "function") {
  // Kit's start() numbers a first entry and leaves one that already has an index alone, so a reload
  // keeps its shallow state. page.state stays {} until a navigation: on hydrate client.js sets it to
  // {} (SvelteKit 2.70.3), and the shallow-routing caveat says state is not applied on the first load
  // (https://kit.svelte.dev/docs/shallow-routing#caveats, read 2026-10-13).
  if (history.state?.[HISTORY_INDEX] == null) history.replaceState(compose({}), "", location.href);
}

export function pushState(url: string, state: PageState): void {
  index += 1;
  history.pushState(compose(state), "", url || `${location.pathname}${location.search}`);
  page.state = state;
}

export function replaceState(url: string, state: PageState): void {
  history.replaceState(compose(state), "", url || `${location.pathname}${location.search}`);
  page.state = state;
}
