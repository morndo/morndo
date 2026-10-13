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

// Arrow keys and drags add `delta` to the chosen width (wider is positive), not to the narrower width
// a tight window is drawing. While that drawn width is below the choice, only a gesture that lands
// wider than what is drawn replaces it. A click, or a nudge that would store the drawn width, does not.
export function commitWidth(chosen: number, drawn: number, delta: number): number {
  const next = clampRight(chosen + delta);
  if (drawn < chosen && !(delta > 0 && next > drawn)) return clampRight(chosen);
  return next;
}
