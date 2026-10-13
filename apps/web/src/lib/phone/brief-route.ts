// Where a brief's sheet sits in the history (ADR-0023 §6.3). The sheet is open while shallow page state names its id.
// `/?decision=<id>` is the link the manager can send; the query is read once and does not stay in the address.

export function briefFromPageState(state: { brief?: unknown } | null | undefined): string | null {
  const id = state?.brief;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function decisionFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("decision");
  return id && id.length > 0 ? id : null;
}
