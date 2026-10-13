// A stand-in for SvelteKit's $app/state in the browser tests (harness.ts), reactive the way the real one is: Phone
// derives the open brief from page.state, so a popstate that swaps it must re-run that derivation. Kit 2.70.3 keeps
// the shallow-routing state under "sveltekit:states" on every entry it numbered; an entry pushed outside the router
// (a raw history.pushState) carries none, and its popstate leaves page.state alone (review round 1, finding 3).
export type PageState = { brief?: string; chat?: string; screen?: boolean };

export const page = $state({ state: {} as PageState, url: new URL("http://localhost/") });

if (typeof addEventListener === "function") {
  addEventListener("popstate", event => {
    const entry = (event as PopStateEvent).state;
    if (!entry || typeof entry !== "object" || !("sveltekit:history" in entry)) return;   // a raw entry: Kit's else branch
    const states = (entry as { "sveltekit:states"?: unknown })["sveltekit:states"];
    page.state = states && typeof states === "object" ? (states as PageState) : {};
  });
}
