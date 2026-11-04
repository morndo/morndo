// Stands in for noVNC's RFB (@novnc/novnc 1.7.0, docs/API.md) in the Desktop tab's web tests. It keeps every instance
// on globalThis.__rfb with what the view set on it and every key and clipboard text the view asked it to send, and
// fires "connect" on the next tick, as a VNC server that lets the view in would. It draws nothing and sends nothing.
// As noVNC does (core/rfb.js, _focusCanvas), a mousedown or touchstart on the screen focuses its canvas while
// focusOnClick is on; and it keeps the event types the view listens for (`listens`).
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
  listens: string[] = [];
  #resize = false;
  #canvas: HTMLCanvasElement;
  constructor(target: HTMLElement, url: string) {
    super();
    this.url = url;
    this.#canvas = document.createElement("canvas");
    this.#canvas.tabIndex = -1;
    this.#canvas.style.cssText = "display:block;width:1px;height:1px";
    target.appendChild(this.#canvas);
    const focusCanvas = () => { if (this.focusOnClick && !this.disconnected) this.#canvas.focus(); };
    target.addEventListener("mousedown", focusCanvas);
    target.addEventListener("touchstart", focusCanvas);
    const w = globalThis as unknown as { __rfb?: RFB[] };
    (w.__rfb ??= []).push(this);
    setTimeout(() => this.dispatchEvent(new Event("connect")), 0);
  }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    this.listens.push(type);
    super.addEventListener(type, listener, options);
  }
  get resizeSession() { return this.#resize; }
  set resizeSession(v: boolean) { this.#resize = v; if (v) this.resized = true; }
  sendKey(...args: unknown[]) { this.keys.push(args); }
  clipboardPasteFrom(text: string) { this.pasted.push(text); }
  focus() { this.#canvas.focus(); }
  blur() {}
  disconnect() { this.disconnected = true; this.#canvas.remove(); }
  getImageData(): ImageData { return new ImageData(1, 1); }
}
