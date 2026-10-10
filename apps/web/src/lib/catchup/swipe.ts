// Swiping a catch-up card (ADR-0009): right or left past a threshold, or a quick flick, decides; anything else springs
// back. The card keeps `touch-action: pan-y`, so a vertical drag stays the browser's scroll and only a horizontal one
// reaches here; the browser taking over sends `pointercancel`, which springs back (MDN, touch-action and
// pointercancel, read 2026-10-03). Every swipe has a button that does the same; this only adds the gesture.

export type Swiped = "left" | "right";

// The swipe's verdict from how far and how fast the finger went: a third of the card's width, or 0.5 px/ms with at
// least 40 px; otherwise nothing.
export function verdict(dx: number, ms: number, width: number): Swiped | null {
  const fast = Math.abs(dx) >= 40 && Math.abs(dx) / Math.max(ms, 1) >= 0.5;
  if (Math.abs(dx) < width / 3 && !fast) return null;
  return dx > 0 ? "right" : "left";
}

// A drag counts as horizontal once it moved 10 px, more sideways than down.
export const horizontal = (dx: number, dy: number) => Math.abs(dx) >= 10 && Math.abs(dx) > Math.abs(dy) * 1.2;

// The Svelte action: `use:swipe={{ onMove, onSwipe }}`. `onMove(dx)` while dragging (0 when it springs back);
// `onSwipe(side)` once decided. Taps on buttons, links and inputs inside the card pass through untouched.
export function swipe(node: HTMLElement, opts: { onMove: (dx: number) => void; onSwipe: (side: Swiped) => void }) {
  let o = opts;
  let start: { x: number; y: number; t: number; id: number } | null = null;
  let dragging = false;
  const interactive = (t: EventTarget | null) => t instanceof Element && !!t.closest("button, a, input, textarea, select, [contenteditable]");
  const reset = () => { start = null; dragging = false; o.onMove(0); };
  const down = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0 || interactive(e.target)) return;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  };
  const move = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!dragging) {
      if (!horizontal(dx, dy)) { if (Math.abs(dy) > 12) start = null; return; }
      dragging = true;
      try { node.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
    }
    o.onMove(dx);
  };
  const up = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const side = dragging ? verdict(e.clientX - start.x, e.timeStamp - start.t, node.clientWidth) : null;
    reset();
    if (side) o.onSwipe(side);
  };
  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", reset);
  return {
    update(next: typeof opts) { o = next; },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", reset);
    },
  };
}

// Press and hold (600 ms) on a button: `onHold` fires once, and the click that ends the press is swallowed. A short
// press is an ordinary click. `-webkit-touch-callout: none` on the button keeps iOS's callout away.
export function hold(node: HTMLElement, onHold: () => void) {
  let fire = onHold;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const down = (e: PointerEvent) => { if (!e.isPrimary) return; held = false; clear(); timer = setTimeout(() => { held = true; timer = null; fire(); }, 600); };
  const click = (e: MouseEvent) => { if (held) { e.preventDefault(); e.stopImmediatePropagation(); held = false; } };
  node.addEventListener("pointerdown", down);
  node.addEventListener("pointerup", clear);
  node.addEventListener("pointercancel", clear);
  node.addEventListener("pointerleave", clear);
  node.addEventListener("click", click, true);
  return {
    update(next: () => void) { fire = next; },
    destroy() {
      clear();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointerup", clear);
      node.removeEventListener("pointercancel", clear);
      node.removeEventListener("pointerleave", clear);
      node.removeEventListener("click", click, true);
    },
  };
}
