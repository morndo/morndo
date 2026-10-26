// The start of a text file for its preview in the chat. An HTML page the owner attached can be 10 MB and six can sit in
// one message, so only the first `limit` bytes are read and the rest of the body is let go (ReadableStream cancel).

export type PreviewStart = { text: string; cut: boolean };

export async function readStart(body: ReadableStream<Uint8Array>, limit: number): Promise<PreviewStart> {
  const reader = body.getReader();
  const kept = new Uint8Array(limit);
  let have = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, limit - have);
    kept.set(value.subarray(0, take), have);
    have += take;
    if (take < value.length) { cut = true; break; }
  }
  if (cut) await reader.cancel();
  // A cut can fall inside a character: the decoder holds back an unfinished one instead of showing half of it.
  const text = new TextDecoder().decode(kept.subarray(0, have), { stream: cut });
  return { text, cut };
}
