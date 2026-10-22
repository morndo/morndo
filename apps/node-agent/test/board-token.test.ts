// The token the reply style ask reads the hub's board with (T-308): a file only the node's user can read, read when it is
// used and never from the environment, so no lane the node starts holds it.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropAgentTokenEnv, readBoardToken } from "../src/relay/board-token.ts";
import { tempHome } from "./helpers.ts";

let home: { home: string; cleanup: () => void };
let file = "";
beforeEach(() => { home = tempHome(); file = join(home.home, "board-token"); });
afterEach(() => { home.cleanup(); });
const write = (text: string, mode = 0o600) => { writeFileSync(file, text, { mode }); chmodSync(file, mode); };

describe("the board token file", () => {
  it("reads a token from a file only its owner can read, without the line's end", () => {
    write("mgr_secret-token\n");
    expect(readBoardToken(file)).toBe("mgr_secret-token");
    write("mgr_secret-token", 0o400);
    expect(readBoardToken(file)).toBe("mgr_secret-token");
  });

  it("is read at each use: a replaced token is the one used", () => {
    write("mgr_one");
    expect(readBoardToken(file)).toBe("mgr_one");
    write("mgr_two");
    expect(readBoardToken(file)).toBe("mgr_two");
  });

  it("gives none for a file other users can read (group or world), a missing file, a link, a directory", () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666, 0o700 | 0o010]) {
      write("mgr_secret-token", mode);
      expect(readBoardToken(file), mode.toString(8)).toBeNull();
    }
    expect(readBoardToken(join(home.home, "none"))).toBeNull();
    write("mgr_secret-token");
    const link = join(home.home, "link");
    symlinkSync(file, link);
    expect(readBoardToken(link)).toBeNull();
    const dir = join(home.home, "dir");
    mkdirSync(dir, { mode: 0o700 });
    expect(readBoardToken(dir)).toBeNull();
  });

  it("gives none for an empty file, a token with a space or a line break inside, or one that is too long", () => {
    for (const text of ["", "  \n", "two words", "line\nbreak", "a".repeat(5000)]) {
      write(text);
      expect(readBoardToken(file), JSON.stringify(text.slice(0, 20))).toBeNull();
    }
  });
});

describe("MORNDO_AGENT_TOKEN in the node's environment", () => {
  it("is removed from the environment it is given, and says whether a token was there", () => {
    const env: NodeJS.ProcessEnv = { MORNDO_AGENT_TOKEN: "mgr_secret-token", PATH: "/bin", MORNDO_LANE: "manager" };
    expect(dropAgentTokenEnv(env)).toBe(true);
    expect(env).toEqual({ PATH: "/bin", MORNDO_LANE: "manager" });
    expect(dropAgentTokenEnv(env)).toBe(false);
    const empty: NodeJS.ProcessEnv = { MORNDO_AGENT_TOKEN: "" };
    expect(dropAgentTokenEnv(empty)).toBe(false);                         // nothing to warn about, and nothing left
    expect(empty).toEqual({});
  });
});
