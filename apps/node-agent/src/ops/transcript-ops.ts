// transcript.* (spec §3.1, §5.3): a Claude Code session's transcript as bytes, found through the session registry on
// this node and read with node-ops' byte source. At most 256 KiB per read (LIMITS.chunkBytes, checked in args.ts),
// base64 on the wire; the hub's parser carries partial lines across reads.
import { localTranscriptBytes } from "@morndo/node-ops";
import { fail, ok, read, type OpTable } from "./executor.ts";

export function transcriptOps(d: { transcriptPath: (sessionId: string) => string | null }): Pick<OpTable, "transcript.size" | "transcript.read" | "transcript.locate"> {
  const source = (sessionId: string) => {
    const path = d.transcriptPath(sessionId);
    return path === null ? null : localTranscriptBytes(path);
  };
  return {
    "transcript.size": read(async a => ok<"transcript.size">({ size: (await source(a.sessionId)?.size()) ?? null })),
    "transcript.read": read(async a => {
      const got = await source(a.sessionId)?.read(a.offset, a.max);
      if (!got) return fail("bad_args", "no transcript of that session on this node");
      return ok<"transcript.read">({ bytes: Buffer.from(got.bytes).toString("base64"), eof: got.eof });
    }),
    "transcript.locate": read(async a => ok<"transcript.locate">({ offset: (await source(a.sessionId)?.locate(a.needle)) ?? null })),
  };
}
