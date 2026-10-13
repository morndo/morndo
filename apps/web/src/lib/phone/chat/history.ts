import { MANAGER } from "../../manager.ts";
// A chat is one history entry. Opening the chat that is already the current entry does not push another,
// so Back closes it instead of opening it again. After a reload the entry is still there: the chat comes back from it.
export function chatEntry(stateChat: string | null | undefined, worker: string): "push" | "stay" {
  return stateChat === worker ? "stay" : "push";
}

// One entry's chat state, wherever the router kept it: Kit 2.70.3 nests shallow-routing state under
// "sveltekit:states" on the entries it owns, and an entry pushed outside the router keeps it at the top (finding 3).
export function entryChatState(state: unknown): ChatHistoryState {
  if (!state || typeof state !== "object") return null;
  const nested = (state as { "sveltekit:states"?: unknown })["sveltekit:states"];
  return (nested ?? state) as ChatHistoryState;
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
export function keptChat(id: string | null, workers: readonly { id: string; name?: string }[], primed: boolean, name: string | null = null): string | null {
  if (id === null || !primed) return id;
  if (workers.some(w => w.id === id)) return id;
  // The manager's chat follows it across a restart (its window gone, or back): the one worker listed by its name.
  return name === MANAGER ? workers.find(w => w.name === MANAGER)?.id ?? null : null;
}
