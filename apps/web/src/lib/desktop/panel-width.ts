// The decisions panel stays beside the conversation while the conversation keeps 560px. The rail is 70px and the
// resizer 4px. Widening never uses a width that would flip the layout to the overlay mid-gesture.
export const RIGHT_MIN = 360;
export const RIGHT_MAX = 640;
export const DOCK_CHROME = 74;
export const CONVERSATION_MIN = 560;

export const clampRight = (n: number) => Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(n)));

export function maxDockedWidth(windowWidth: number, sidebarWidth: number): number {
  return windowWidth - DOCK_CHROME - sidebarWidth - CONVERSATION_MIN;
}

// Overlay only when even the narrowest panel would squeeze the conversation. The chosen width does not decide it.
export function layoutIsNarrow(windowWidth: number, sidebarWidth: number): boolean {
  return maxDockedWidth(windowWidth, sidebarWidth) < RIGHT_MIN;
}

export function dockedWidth(requested: number, windowWidth: number, sidebarWidth: number): number {
  const clamped = clampRight(requested);
  if (layoutIsNarrow(windowWidth, sidebarWidth)) return clamped;
  return Math.min(clamped, maxDockedWidth(windowWidth, sidebarWidth));
}

// A window or sidebar change never replaces the width the owner chose. The panel draws `drawn`;
// only a grip or an arrow key stores a new `chosen`.
export function widthAfterWindowChange(chosen: number, windowWidth: number, sidebarWidth: number): { chosen: number; drawn: number } {
  const kept = clampRight(chosen);
  return { chosen: kept, drawn: dockedWidth(kept, windowWidth, sidebarWidth) };
}

// Wider is positive. Narrowing starts from the edge on screen and always stores that width.
// Widening is added to the chosen width, and replaces it when the result passes what is drawn.
// A click stores neither the drawn width nor a new one.
export function commitWidth(chosen: number, drawn: number, delta: number): number {
  if (delta < 0) return clampRight(drawn + delta);
  const next = clampRight(chosen + delta);
  if (drawn < chosen && next <= drawn) return clampRight(chosen);
  return next;
}
