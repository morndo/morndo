// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // Shallow routing for the phone's brief sheet (ADR-0023 §6.3): set by pushState, read as page.state.brief.
    interface PageState {
      brief?: string;
    }
  }
}
export {};
