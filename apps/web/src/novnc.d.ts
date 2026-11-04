// Types for the parts of noVNC's RFB (https://github.com/novnc/noVNC/blob/v1.7.0/docs/API.md) the Desktop tab uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: { password?: string }; wsProtocols?: string[] });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    showDotCursor: boolean;
    readonly clippingViewport: boolean;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    getImageData(): ImageData;
  }
}
