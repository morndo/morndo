// Full screen for one view (the Desktop or Terminal tab), as a toggle: the same button enters full screen and, while
// the view is full screen, leaves it. Escape still leaves too, as the browser shows; `on` follows the browser's own
// fullscreenchange, so the button's icon and label are right however full screen ended. Before, the button only ever
// asked for full screen, so a click while in full screen did nothing.
export class FullscreenToggle {
  on = $state(false);
  #el: () => HTMLElement | null;

  constructor(el: () => HTMLElement | null) {
    this.#el = el;
    $effect(() => {
      const sync = () => { this.on = document.fullscreenElement !== null && document.fullscreenElement === this.#el(); };
      sync();
      document.addEventListener("fullscreenchange", sync);
      return () => document.removeEventListener("fullscreenchange", sync);
    });
  }

  toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void this.#el()?.requestFullscreen?.().catch(() => {});
  };
}
