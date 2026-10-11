// The settings page's words are the protocol table. A heading typed into the component would fail here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTION_WORDS } from "@morndo/protocol";
import { expiryMillis, expiryText, keyAddLine, subscriptionAddLine } from "../src/lib/connections/line.ts";

const board = readFileSync(new URL("../src/lib/connections/ConnectionsBoard.svelte", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/routes/engines/+page.svelte", import.meta.url), "utf8");

describe("the connections page uses the protocol words", () => {
  it("imports the table and does not quote its title or its modes", () => {
    expect(board).toContain("CONNECTION_WORDS");
    expect(page).toContain("CONNECTION_WORDS.title");
    expect(page).toContain('class="connections"');
    expect(page.match(/api\.get[^\n]*\/api\/me/g)).toHaveLength(1);
    expect(board).not.toContain(`"${CONNECTION_WORDS.title}"`);
    expect(page).not.toContain(`"${CONNECTION_WORDS.title}"`);
    for (const label of Object.values(CONNECTION_WORDS.modes)) expect(board).not.toContain(`"${label}"`);
    expect(board).not.toMatch(/type="password"|apiKey|secret/);
    expect(CONNECTION_WORDS.remove).toBe("Remove");
    expect(board).toContain("{CONNECTION_WORDS.remove}");
    expect(board).toContain("aria-label={`${CONNECTION_WORDS.remove} ${pick}`}");
  });

  it("the add line names the command and never a key", () => {
    const line = keyAddLine({ name: "key-a", vendor: "openai", runtime: "codex", budget: "20", expires: "" });
    expect(line.startsWith(CONNECTION_WORDS.addLine)).toBe(true);
    expect(line).toBe(`${CONNECTION_WORDS.addLine} key-a --vendor openai --runtime codex --billing metered --budget 20 < keyfile`);
    expect(line).not.toContain("pbpaste");
    expect(keyAddLine({ name: "key-a", vendor: "openai", runtime: "codex", budget: "", expires: "" })).toBe("");
    expect(keyAddLine({ name: "key-a", vendor: "openai", runtime: "codex", budget: "unlimited", expires: "" })).toContain("--budget unlimited");
    expect(line).not.toMatch(/sk-|secret/);
    expect(keyAddLine.length).toBe(1);
    expect(subscriptionAddLine({ name: "sub-a", vendor: "claude", runtime: "claude" })).toContain("--subscription true");
    const expires = expiryMillis("10 Oct 2026");
    expect(expires).not.toBe("");
    expect(expiryText(Number(expires))).toBe("10 Oct 2026");
    expect(expiryMillis("32 Oct 2026")).toBe("");
    expect(keyAddLine({ name: "key-a", vendor: "openai", runtime: "codex", budget: "20", expires })).toContain(`--expires ${expires}`);
  });
});
