import { describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { present, stripButtonsLine, stripMarkers } from "../src/lib/desktop/present.ts";
import { toRows } from "../src/lib/desktop/grouping.ts";

const m = (id: string, text: string, over: Partial<Message> = {}): Message =>
  ({ id, at: Date.UTC(2026, 9, 1, 8, Number(id.replace(/\D/g, "") || 0)), author: { kind: "agent", name: "manager" }, kind: "text", text, ...over });

describe("control markers", () => {
  it("drops leading machine markers, one or several, with or without a detail", () => {
    expect(stripMarkers("[quiet]\n### Studio: Gemini retry")).toBe("### Studio: Gemini retry");
    expect(stripMarkers("[quiet] [lane-event] done")).toBe("done");
    expect(stripMarkers("[tap 3f] Merge now")).toBe("Merge now");
  });
  it("keeps what isn't a marker (negative controls)", () => {
    expect(stripMarkers("[the docs](https://example.test) say so")).toBe("[the docs](https://example.test) say so");
    expect(stripMarkers("[x] done")).toBe("[x] done");
    expect(stripMarkers("Reply [quiet] later")).toBe("Reply [quiet] later");
    expect(stripMarkers("[This is a long sentence in brackets that goes past the forty character detail limit] hi"))
      .toBe("[This is a long sentence in brackets that goes past the forty character detail limit] hi");
  });
});

describe("clean and verbose", () => {
  const msgs: Message[] = [
    m("m1", "[quiet]\nStudio finished"),
    m("m2", "Lane events arrived.", { kind: "event", author: { kind: "system", name: "kira" } }),
    m("m3", "Bash", { kind: "activity", tools: ["Bash"] }),
    m("m4", "[quiet]"),
    m("m5", "/remote-control", { kind: "event", author: { kind: "principal", name: "You" } }),
  ];
  it("clean: strips markers, hides system plumbing and messages that were only a marker", () => {
    const shown = present(msgs, { show: "clean", activity: true });
    expect(shown.map(x => x.id)).toEqual(["m1", "m3", "m5"]);
    expect(shown[0]?.text).toBe("Studio finished");
  });
  it("verbose: everything, exactly as written", () => {
    expect(present(msgs, { show: "verbose", activity: true })).toEqual(msgs);
  });
  it("tool activity can be hidden in either mode", () => {
    expect(present(msgs, { show: "verbose", activity: false }).map(x => x.id)).not.toContain("m3");
    expect(present(msgs, { show: "clean", activity: false }).map(x => x.id)).toEqual(["m1", "m5"]);
  });
});

describe("grouping", () => {
  it("folds consecutive tool use and groups one author's messages", () => {
    const rows = toRows([m("m1", "a"), m("m2", "Read", { kind: "activity", tools: ["Read"] }), m("m3", "Read", { kind: "activity", tools: ["Read"] }), m("m4", "b")]);
    expect(rows.map(r => r.kind)).toEqual(["day", "msg", "activity", "msg"]);
    const act = rows[2];
    expect(act?.kind === "activity" && act.tools).toEqual([{ name: "Read", count: 2 }]);
    const last = rows[3];
    expect(last?.kind === "msg" && last.head).toBe(false);
  });
});

describe("decisions in the chat", () => {
  it("drops the manager's trailing buttons line in clean mode, the app shows buttons instead", () => {
    expect(stripButtonsLine("Ready to ship.\n\n[buttons ny-7] ship=Ship it | hold=Hold")).toBe("Ready to ship.");
    expect(stripButtonsLine("[buttons ny-7] in the middle\nstays")).toBe("[buttons ny-7] in the middle\nstays");
    const [shown] = present([m("m1", "[quiet]\nReady.\n[buttons ny-7] ship=Ship it")], { show: "clean", activity: true });
    expect(shown?.text).toBe("Ready.");
    expect(present([m("m1", "Ready.\n[buttons ny-7] ship=Ship it")], { show: "verbose", activity: true })[0]?.text).toContain("[buttons ny-7]");
  });
  it("shows the principal's tap as what he chose (negative control: an agent's text is left alone)", () => {
    const you = { kind: "principal" as const, name: "You" };
    const [tap] = present([m("m1", "[tap ny-7] ship (Ship it)", { author: you })], { show: "clean", activity: true });
    expect(tap).toMatchObject({ kind: "event", text: "chose “Ship it” · ny-7" });
    const [agent] = present([m("m2", "[tap ny-7] ship (Ship it)")], { show: "clean", activity: true });
    expect(agent?.kind).toBe("text");
  });
});

describe("files", () => {
  const you = { kind: "principal" as const, name: "You" };
  const att = { id: "a".repeat(32), name: "photo.jpg", mime: "image/jpeg", kind: "image" as const, size: 10, caption: null };
  it("drops the chat bot's note for an attached file in clean mode; verbose keeps it", () => {
    const msg = m("m1", "Look at this\n\n[The owner attached a file: /inbox/1-photo.jpg]", { author: you, attachments: [att] });
    expect(present([msg], { show: "clean", activity: true })[0]?.text).toBe("Look at this");
    expect(present([msg], { show: "verbose", activity: true })[0]?.text).toContain("[The owner attached a file");
  });
  it("keeps a message that is only a file, and a file message from an agent", () => {
    const only = m("m2", "[The owner attached a file: /inbox/2-photo.jpg]", { author: you, attachments: [att] });
    const sent = m("m3", "", { kind: "file", attachments: [att] });
    expect(present([only, sent], { show: "clean", activity: true }).map(x => [x.id, x.text])).toEqual([["m2", ""], ["m3", ""]]);
  });
});
