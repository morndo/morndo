// A chat is one history entry. Opening the chat that is already the current entry does not push another,
// so Back closes it instead of opening it again. After a reload the entry is still there: the chat comes back from it.
export function chatEntry(stateChat: string | null | undefined, worker: string): "push" | "stay" {
  return stateChat === worker ? "stay" : "push";
}

// One history entry, as Phone writes it: the open chat and whether its screen is showing.
type ChatHistoryState = { chat?: unknown; screen?: unknown } | null;

export function restoredChat(state: ChatHistoryState, roster?: readonly { id: string }[]): string | null {
  const id = typeof state?.chat === "string" ? state.chat : null;
  if (!id) return null;
  if (roster && !roster.some(w => w.id === id)) return null;
  return id;
}

export function restoredScreen(state: ChatHistoryState): boolean {
  return state?.screen === true;
}

// A chat restored before the roster arrives stays until the roster says that lane is gone.
export function keptChat(id: string | null, workers: readonly { id: string }[], primed: boolean): string | null {
  if (id === null || !primed) return id;
  return workers.some(w => w.id === id) ? id : null;
}
