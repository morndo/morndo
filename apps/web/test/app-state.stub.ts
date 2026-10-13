// A stand-in for SvelteKit's $app/state in component tests. The real app reads page.state.brief (shallow routing).
export const page = {
  state: {} as { brief?: string },
  url: new URL("http://localhost/"),
};

if (typeof addEventListener === "function") {
  addEventListener("popstate", () => {
    const raw = history.state && typeof history.state === "object" && "__page" in history.state ? history.state.__page : null;
    page.state = raw && typeof raw === "object" ? raw as { brief?: string } : {};
  });
}
