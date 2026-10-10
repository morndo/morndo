// Keeping the composer above the on-screen keyboard (ADR-0011). iOS Safari doesn't resize the page for the keyboard and
// doesn't support `interactive-widget` or `env(keyboard-inset-*)`; it shrinks and moves the visual viewport instead
// (MDN VisualViewport and the viewport meta's compatibility data, read 2026-10-05). So the conversation is fixed to the
// visual viewport: its top at `offsetTop`, its bottom lifted by what the keyboard covers.
export type Viewport = { height: number; offsetTop: number };

export function keyboardInset(innerHeight: number, vv: Viewport | null): { top: number; bottom: number } {
  if (!vv) return { top: 0, bottom: 0 };
  return { top: Math.max(0, Math.round(vv.offsetTop)), bottom: Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) };
}

// Sets --vv-top and --kb on `el` while the visual viewport moves; returns the stop function.
export function followKeyboard(el: HTMLElement): () => void {
  const vv = window.visualViewport;
  const apply = () => {
    const v = window.visualViewport;
    const k = keyboardInset(window.innerHeight, v ? { height: v.height, offsetTop: v.offsetTop } : null);
    el.style.setProperty("--vv-top", `${k.top}px`);
    el.style.setProperty("--kb", `${k.bottom}px`);
    el.classList.toggle("kb-open", k.bottom > 80);
  };
  apply();
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  addEventListener("resize", apply);
  return () => { vv?.removeEventListener("resize", apply); vv?.removeEventListener("scroll", apply); removeEventListener("resize", apply); };
}
