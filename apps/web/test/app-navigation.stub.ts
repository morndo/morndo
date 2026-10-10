// A stand-in for SvelteKit's $app/navigation in the component tests (harness.ts): Phone.svelte calls goto, which only
// SvelteKit's router provides. It records where the app asked to go (globalThis.__goto) and goes nowhere.
export function beforeNavigate(_fn: (nav: { type: string; cancel: () => void }) => void): void {}

export async function goto(url: string | URL): Promise<void> {
  const g = globalThis as unknown as { __goto?: string[] };
  (g.__goto ??= []).push(String(url));
}
