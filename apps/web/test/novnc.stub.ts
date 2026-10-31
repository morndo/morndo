// Stands in for noVNC's RFB (@novnc/novnc 1.7.0, docs/API.md) in the Desktop tab's web tests. It keeps every instance
// on globalThis.__rfb with what the view set on it and every key and clipboard text the view asked it to send, and
// fires "connect" on the next tick, as a VNC server that lets the view in would. It draws nothing and sends nothing.
export default class RFB extends EventTarget {
  url: string;
  viewOnly = false;
  focusOnClick = true;
  scaleViewport = false;
  clipViewport = false;
  dragViewport = false;
  showDotCursor = false;
  qualityLevel = 6;
  compressionLevel = 2;
  background = "";
  clippingViewport = false;
  keys: unknown[][] = [];
  pasted: string[] = [];
  resized = false;                                   // resizeSession was set true at some point
  disconnected = false;
  #resize = false;
  constructor(target: HTMLElement, url: string) {
    super();
    void target;
    this.url = url;
    const w = globalThis as unknown as { __rfb?: RFB[] };
    (w.__rfb ??= []).push(this);
    setTimeout(() => this.dispatchEvent(new Event("connect")), 0);
  }
  get resizeSession() { return this.#resize; }
  set resizeSession(v: boolean) { this.#resize = v; if (v) this.resized = true; }
  sendKey(...args: unknown[]) { this.keys.push(args); }
  clipboardPasteFrom(text: string) { this.pasted.push(text); }
  focus() {}
  blur() {}
  disconnect() { this.disconnected = true; }
  getImageData(): ImageData { return new ImageData(1, 1); }
}
