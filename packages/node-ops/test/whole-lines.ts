// Reading the files a fake box and its transcript grow while a test runs. The box appends each line with one write, but a
// reader can run while that write is half done, and then sees the start of a long line; that part is not a line yet and
// waits for the rest. Shared by the node agent's tests, the hub's tests and the fleet drills.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The lines a text holds so far that are whole: each ended by its newline.
export function wholeLines(text: string): string[] {
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n").filter(Boolean);
}

// The JSON values on the whole lines of a file; none while the file is not there.
export function readJsonLines(file: string): unknown[] {
  return existsSync(file) ? wholeLines(readFileSync(file, "utf8")).map(l => JSON.parse(l) as unknown) : [];
}

// What a fake box in <dir> has had submitted so far (its submitted.jsonl, one JSON string per line).
export function readSubmitted(dir: string): string[] {
  return readJsonLines(join(dir, "submitted.jsonl")) as string[];
}
