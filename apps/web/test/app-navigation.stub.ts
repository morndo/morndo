// A stand-in for SvelteKit's $app/navigation in the component tests (harness.ts): Phone.svelte calls goto and
// pushState, which only SvelteKit's router provides. goto records where the app asked to go and goes nowhere.
// pushState keeps the brief id on history, the way Kit 2.70.3's shallow routing does (design §6.3).
import { page } from "./app-state.stub.ts";

export function beforeNavigate(_fn: (nav: { type: string; cancel: () => void }) => void): void {}

export async function goto(url: string | URL): Promise<void> {
  const g = globalThis as unknown as { __goto?: string[] };
  (g.__goto ??= []).push(String(url));
}

export function pushState(_url: string, state: { brief?: string }): void {
  history.pushState({ ...(history.state ?? {}), __page: state }, "", `${location.pathname}${location.search}`);
  page.state = state;
}

export function replaceState(_url: string, state: { brief?: string }): void {
  history.replaceState({ ...(history.state ?? {}), __page: state }, "", `${location.pathname}${location.search}`);
  page.state = state;
}
