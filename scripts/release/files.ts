// files.json is the signed list inside a Version (design §5, §9.6). It names every other file.
// Its own digest is the Manifest's filesSha256, so it is not an entry: a hash cannot contain itself.
import { createHash } from "node:crypto";
import { FileListSchema } from "@morndo/protocol";
import { assertTreePath, type TreeFile } from "./archive.ts";
import { canonicalJson } from "./json.ts";

export function listFiles(files: readonly TreeFile[]): { json: string; sha256: string } {
  const entries = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(file => {
      assertTreePath(file.path);
      const bytes = "link" in file ? Buffer.from(file.link) : "directory" in file ? Buffer.alloc(0) : file.bytes;
      return { path: file.path, mode: file.mode, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  const parsed = FileListSchema.safeParse(entries);
  if (!parsed.success) throw new Error("file list is not the wire's shape");
  const json = canonicalJson(entries);
  return { json, sha256: createHash("sha256").update(json).digest("hex") };
}
