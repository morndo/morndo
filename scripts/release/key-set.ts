// The key-set version a feed names is the version in the shipped trust/keys.json (design §9.6),
// not a number written into the workflow, so the first rotation does not break later publishes.
import { readFileSync } from "node:fs";
import { KeySetSchema } from "@morndo/protocol";

export function keySetVersion(path: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`key set unreadable: ${error instanceof Error ? error.message : "not JSON"}`);
  }
  const keys = KeySetSchema.safeParse(parsed);
  if (!keys.success) throw new Error("key set is not the wire's shape");
  return keys.data.version;
}
