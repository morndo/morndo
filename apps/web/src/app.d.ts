// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // Shallow routing for the phone (ADR-0023 §6.3): the brief sheet's entry sets `brief`, a conversation's sets
    // `chat` and whether its screen is showing. All are written by pushState and read as page.state.
    interface PageState {
      brief?: string;
      chat?: string;
      screen?: boolean;
    }
  }
}
export {};
