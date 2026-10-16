// The deliverer's transcript view says where each whole line starts, so a receipt can be required to come after the typing.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentTranscripts } from "../src/deliveries/views.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

describe("agentTranscripts.lines", () => {
  it("returns the byte offset each line starts at, multi-byte text and a half-written last line included", async () => {
    const home = tempHome();
    homes.push(home);
    const path = join(home.home, "t.jsonl");
    writeFileSync(path, '{"a":"é"}\n\n{"b":2}\n{"c"');
    const view = agentTranscripts(() => path);
    const got = await view.lines("s", 0);
    expect(got?.lines).toEqual(['{"a":"é"}', '{"b":2}']);
    expect(got?.starts).toEqual([0, 12]);                       // "é" is two bytes; the empty line between them is skipped
    expect(got?.next).toBe(20);
    appendFileSync(path, ':3}\n');
    const more = await view.lines("s", got!.next);
    expect(more?.lines).toEqual(['{"c":3}']);
    expect(more?.starts).toEqual([20]);
  });
});
