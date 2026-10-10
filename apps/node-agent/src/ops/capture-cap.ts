// A pane capture capped for the wire (spec §5.2 "Frames"; plan Review Focus 3): 64 panes with full captures must fit
// one 512 KiB message, so each capture keeps at most 6 KiB (LIMITS.captureBytesPerPane) measured as it travels, JSON
// encoded, quotes and escapes included. The bottom of a pane matters most (the input box, a menu), so the cut keeps
// the end and starts at a line boundary, and never splits a character.
const jsonBytes = (s: string) => Buffer.byteLength(JSON.stringify(s));

export function capCapture(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (jsonBytes(text) <= maxBytes) return { text, truncated: false };
  let lo = 0, hi = text.length;                                  // the smallest start whose tail fits
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (jsonBytes(text.slice(mid)) <= maxBytes) hi = mid; else lo = mid + 1;
  }
  let start = lo;
  const nl = text.indexOf("\n", start);
  if (nl !== -1 && nl + 1 < text.length) start = nl + 1;        // begin at a whole line
  else if (start < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start += 1;   // not inside a surrogate pair
  return { text: text.slice(start), truncated: true };
}
