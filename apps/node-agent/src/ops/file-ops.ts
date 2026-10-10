// file.stat, file.get and file.put (spec §3.1, §5.3). Paths go through node-files.ts' opener (today's rules, 25 MiB,
// O_NOFOLLOW after the check); refs name the hook relay's own copies. Each read works on the handle that was checked,
// never on the path again. Reads are chunked, at most 256 KiB each.
import type { FileHandle } from "node:fs/promises";
import { fail, ok, read, effect, type Failure, type OpTable } from "./executor.ts";
import { openOwn, readChunk, type Opened } from "./node-files.ts";
import type { UploadInbox } from "./upload-inbox.ts";

export type FileDeps = {
  open: (path: string) => Promise<Opened>;
  relayRef: (ref: string) => { file: string; size: number } | null;
  inbox: UploadInbox;
};

const REASON = {
  missing: ["bad_args", "no such file on this node"],
  denied: ["denied", "that file is in a place this node never shares"],
  secret: ["denied", "that file's name marks a secret"],
  not_file: ["denied", "that is not a regular file"],
  too_large: ["too_large", "files are shared up to 25 MiB"],
} as const;

export function fileOps(d: FileDeps): Pick<OpTable, "file.stat" | "file.get" | "file.put"> {
  // The open file a path or a ref names, or the refusal.
  const target = async (a: { path?: string; ref?: string }): Promise<{ fh: FileHandle } | Failure> => {
    if (a.ref !== undefined) {
      const r = d.relayRef(a.ref);
      const fh = r ? await openOwn(r.file) : null;
      return fh ? { fh } : fail("bad_args", "no relay copy with that ref");
    }
    const c = await d.open(a.path ?? "");
    if (c.ok) return { fh: c.fh };
    const [code, message] = REASON[c.reason];
    return fail(code, message);
  };
  return {
    "file.stat": read(async a => {
      const t = await target(a);
      if ("ok" in t) return t;
      try {
        const st = await t.fh.stat();
        return ok<"file.stat">({ size: st.size, mtime: st.mtimeMs });
      } finally { await t.fh.close(); }
    }),
    "file.get": read(async a => {
      const t = await target(a);
      if ("ok" in t) return t;
      try { return ok<"file.get">(await readChunk(t.fh, a.offset, a.max)); }
      finally { await t.fh.close(); }
    }),
    "file.put": effect(a => `upload:${a.upload}`, (a, ctx) => d.inbox.put(a, ctx)),
  };
}
