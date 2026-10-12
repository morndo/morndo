// What the Knowledge commands (sop-check, models-dev) share, one copy each: an error as one line, the name of a model
// snapshot in the cache directory, and how a snapshot file is read.
import { readFileSync } from "node:fs";
import { readSnapshot, type ModelSnapshot } from "../../packages/domain/src/knowledge-facts.ts";
import { err, type Result } from "../../packages/domain/src/shared.ts";

export const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
// A snapshot is <YYYY-MM-DD>.json, named for the day it was fetched; the date is the first group.
export const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

// A snapshot file as models-dev show reads it: JSON that readSnapshot accepts, or why not, in words that follow its name.
export function readSnapshotFile(path: string): Result<ModelSnapshot, string> {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return err(`not JSON: ${firstLine(e)}`);
  }
  return readSnapshot(doc);
}
