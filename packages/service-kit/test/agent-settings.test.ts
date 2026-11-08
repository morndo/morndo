// The settings a lane's commands need (hub address, node name, agent token, lane name), read from the files under
// ~/.config/morndo when the environment has none. This is what the per-machine wrappers did by hand (T-318, P1). Every
// token here is a made-up string.
import { describe, expect, it } from "vitest";
import { agentSettingsIo, laneFromTmux, withAgentSettings, type AgentEnv, type AgentSettingsIo } from "../src/agent-settings.ts";

const HOME = "/home/lane";
const DIR = `${HOME}/.config/morndo`;
const FILES = {
  [`${DIR}/agent-hub`]: "https://hub.example.test\n",
  [`${DIR}/agent-node`]: "build-pc\n",
  [`${DIR}/agent-lanes.token`]: "fake-lane-token\n",
  [`${DIR}/agent-manager.token`]: "fake-manager-token\n",
};

// An io over an in-memory folder; `reads` is every path asked for, `lanes` how often the window was asked.
function io(files: Record<string, string>, window: string | null = null) {
  const reads: string[] = [];
  const state = { lanes: 0 };
  const made: AgentSettingsIo = {
    home: HOME,
    readText: async path => { reads.push(path); return path in files ? files[path]! : null; },
    lane: async () => { state.lanes += 1; return window; },
  };
  return { made, reads, state };
}

describe("withAgentSettings: an empty environment is filled from the files", () => {
  it("a lane window gets the hub, the node, the lane token and its own name", async () => {
    const { made } = io(FILES, "builder");
    const got = await withAgentSettings({}, made);
    expect(got.MORNDO_HUB).toBe("https://hub.example.test");
    expect(got.MORNDO_NODE).toBe("build-pc");
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
    expect(got.MORNDO_LANE).toBe("builder");
  });

  it("the manager's window gets the manager's token, and only that window does", async () => {
    const { made, reads } = io(FILES, "manager");
    expect((await withAgentSettings({}, made)).MORNDO_AGENT_TOKEN).toBe("fake-manager-token");
    expect(reads).not.toContain(`${DIR}/agent-lanes.token`);
    const other = io(FILES, "builder");
    await withAgentSettings({}, other.made);
    expect(other.reads, "a lane never opens the manager's token file").not.toContain(`${DIR}/agent-manager.token`);
  });

  it("MORNDO_LANE in the environment decides the token and the window is not asked", async () => {
    const m = io(FILES, "builder");
    const got = await withAgentSettings({ MORNDO_LANE: "manager" }, m.made);
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-manager-token");
    expect(got.MORNDO_LANE).toBe("manager");
    expect(m.state.lanes).toBe(0);
  });

  it("no lane known (no MORNDO_LANE, no window): the lane token, and MORNDO_LANE stays unset", async () => {
    const { made, reads } = io(FILES, null);
    const got = await withAgentSettings({}, made);
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
    expect(got.MORNDO_LANE).toBeUndefined();
    expect(reads).not.toContain(`${DIR}/agent-manager.token`);
  });

  it("for a lane window reads the hub, node and lane-token files, and nothing else", async () => {
    const { made, reads } = io(FILES, "builder");
    await withAgentSettings({}, made);
    expect([...reads].sort()).toEqual([`${DIR}/agent-hub`, `${DIR}/agent-lanes.token`, `${DIR}/agent-node`].sort());
  });
});

describe("withAgentSettings: the environment wins", () => {
  it("each value that is set stays, whatever the files say", async () => {
    const env: AgentEnv = { MORNDO_HUB: "https://other.example.test", MORNDO_NODE: "n2", MORNDO_AGENT_TOKEN: "env-token", MORNDO_LANE: "builder" };
    const { made, reads } = io(FILES, "manager");
    const got = await withAgentSettings(env, made);
    expect(got).toEqual(env);
    expect(reads, "nothing is read when nothing is missing").toEqual([]);
  });

  it("an empty value counts as unset, as the wrappers' -z test did", async () => {
    const { made } = io(FILES, "builder");
    const got = await withAgentSettings({ MORNDO_HUB: "", MORNDO_AGENT_TOKEN: "  " }, made);
    expect(got.MORNDO_HUB).toBe("https://hub.example.test");
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
  });

  it("a token without a hub address, or the reverse, is never paired with the other from a file", async () => {
    const tokenOnly = io(FILES, "builder");
    const got = await withAgentSettings({ MORNDO_AGENT_TOKEN: "env-token" }, tokenOnly.made);
    expect(got.MORNDO_AGENT_TOKEN).toBe("env-token");
    expect(got.MORNDO_HUB).toBeUndefined();
    expect(got.MORNDO_NODE).toBe("build-pc");                    // the node name is no credential: it is still filled
    expect(tokenOnly.reads).not.toContain(`${DIR}/agent-hub`);
    const hubOnly = io(FILES, "builder");
    const got2 = await withAgentSettings({ MORNDO_HUB: "https://other.example.test" }, hubOnly.made);
    expect(got2.MORNDO_HUB).toBe("https://other.example.test");
    expect(got2.MORNDO_AGENT_TOKEN).toBeUndefined();
    expect(hubOnly.reads).not.toContain(`${DIR}/agent-lanes.token`);
    expect(hubOnly.reads).not.toContain(`${DIR}/agent-manager.token`);
  });

  it("a command that does not use the hub takes its token from the file whatever the hub variable says", async () => {
    const m = io(FILES, "builder");
    const got = await withAgentSettings({ MORNDO_HUB: "https://other.example.test" }, m.made, { skip: ["hub", "node"] });
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
  });

  it("the input is not changed", async () => {
    const env: AgentEnv = { PATH: "/bin" };
    const { made } = io(FILES, "builder");
    const got = await withAgentSettings(env, made);
    expect(env).toEqual({ PATH: "/bin" });
    expect(got.PATH).toBe("/bin");
    expect(got).not.toBe(env);
  });
});

describe("withAgentSettings: missing or unusable files leave today's behaviour", () => {
  it("no files: nothing is set, so each command says what it says today", async () => {
    const { made } = io({}, "builder");
    const got = await withAgentSettings({}, made);
    expect(got.MORNDO_HUB).toBeUndefined();
    expect(got.MORNDO_NODE).toBeUndefined();
    expect(got.MORNDO_AGENT_TOKEN).toBeUndefined();
  });

  it("an empty or blank file counts as missing; only the first line is used", async () => {
    const { made } = io({ [`${DIR}/agent-hub`]: "  \n", [`${DIR}/agent-lanes.token`]: "fake-lane-token\nsecond line\n", [`${DIR}/agent-node`]: "" }, null);
    const got = await withAgentSettings({}, made);
    expect(got.MORNDO_HUB).toBeUndefined();
    expect(got.MORNDO_NODE).toBeUndefined();
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
  });

  it("the real reader answers null for a file it cannot read, and says nothing of why", async () => {
    const reader = agentSettingsIo({ HOME: "/nonexistent-morndo-test-home" });
    expect(await reader.readText("/nonexistent-morndo-test-home/.config/morndo/agent-lanes.token")).toBeNull();
    expect(await reader.readText("/")).toBeNull();   // a directory cannot be read as text either
  });
});

describe("withAgentSettings: a value with a control character is not used", () => {
  it("a control character inside the first line makes the value unset, so it never reaches a header or an error", async () => {
    const { made } = io({ ...FILES, [`${DIR}/agent-lanes.token`]: "fake-lane\rtoken\n", [`${DIR}/agent-hub`]: "https://hub.example.test\u0000x\n", [`${DIR}/agent-node`]: "build\tpc\n" }, "builder");
    const got = await withAgentSettings({}, made);
    expect(got.MORNDO_AGENT_TOKEN).toBeUndefined();
    expect(got.MORNDO_HUB).toBeUndefined();
    expect(got.MORNDO_NODE).toBeUndefined();
  });

  it("a line ending in CRLF is still read: the trailing carriage return is not inside the value", async () => {
    const { made } = io({ ...FILES, [`${DIR}/agent-lanes.token`]: "fake-lane-token\r\n" }, "builder");
    expect((await withAgentSettings({}, made)).MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
  });
});

describe("laneFromTmux asks about the pane the command runs in", () => {
  it("passes -t with TMUX_PANE: the active window of the session is another lane's", async () => {
    const calls: string[][] = [];
    const lane = await laneFromTmux({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%5" }, async args => { calls.push(args); return "builder\n"; });
    expect(lane).toBe("builder");
    expect(calls).toEqual([["display-message", "-p", "-t", "%5", "#W"]]);
  });

  it("outside tmux tmux is not asked and there is no lane", async () => {
    const calls: string[][] = [];
    const ask = async (args: string[]) => { calls.push(args); return "builder"; };
    expect(await laneFromTmux({}, ask)).toBeNull();
    expect(await laneFromTmux({ TMUX_PANE: "%5" }, ask)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("with TMUX but no TMUX_PANE there is no lane and tmux is not asked: the session's active window is never used", async () => {
    const calls: string[][] = [];
    expect(await laneFromTmux({ TMUX: "x" }, async args => { calls.push(args); return "manager"; })).toBeNull();
    expect(await laneFromTmux({ TMUX: "x", TMUX_PANE: "  " }, async args => { calls.push(args); return "manager"; })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("when the pane's own query fails there is no lane, and no second query without -t is made", async () => {
    const calls: string[][] = [];
    const lane = await laneFromTmux({ TMUX: "x", TMUX_PANE: "%5" }, async args => { calls.push(args); return args.includes("-t") ? null : "manager\n"; });
    expect(lane).toBeNull();
    expect(calls).toEqual([["display-message", "-p", "-t", "%5", "#W"]]);
  });

  it("TMUX_PANE is trimmed before it is passed to -t", async () => {
    for (const pane of [" %5", "%5\n", "\t%5 "]) {
      const calls: string[][] = [];
      expect(await laneFromTmux({ TMUX: "x", TMUX_PANE: pane }, async args => { calls.push(args); return "builder\n"; }), JSON.stringify(pane)).toBe("builder");
      expect(calls, JSON.stringify(pane)).toEqual([["display-message", "-p", "-t", "%5", "#W"]]);
    }
  });

  it("a pane query that answers blank is no lane either, and the active window is not asked", async () => {
    const calls: string[][] = [];
    const lane = await laneFromTmux({ TMUX: "x", TMUX_PANE: "%5" }, async args => { calls.push(args); return args.includes("-t") ? "  \n" : "manager\n"; });
    expect(lane).toBeNull();
    expect(calls).toEqual([["display-message", "-p", "-t", "%5", "#W"]]);
  });

  it("a failed or a blank answer from the pane's query is no lane", async () => {
    expect(await laneFromTmux({ TMUX: "x", TMUX_PANE: "%5" }, async () => null)).toBeNull();
    expect(await laneFromTmux({ TMUX: "x", TMUX_PANE: "%5" }, async () => "  \n")).toBeNull();
  });
});

describe("withAgentSettings: a lane tmux cannot name never gets the manager's identity", () => {
  // tmux answers "manager" to a question without -t (the session's active window is the manager's) and fails the one about the pane.
  const activeIsManager = async (args: string[]) => (args.includes("-t") ? null : "manager\n");
  const withTmux = (env: AgentEnv) => {
    const m = io(FILES);
    const made: AgentSettingsIo = { ...m.made, lane: () => laneFromTmux(env, activeIsManager) };
    return { made, reads: m.reads };
  };

  it("TMUX_PANE unset while the manager's window is active: the lane token, no MORNDO_LANE, the manager's file never opened", async () => {
    const { made, reads } = withTmux({ TMUX: "x" });
    const got = await withAgentSettings({}, made, { fillLane: true });
    expect(got.MORNDO_AGENT_TOKEN).not.toBe("fake-manager-token");
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
    expect(got.MORNDO_LANE).toBeUndefined();
    expect(reads).not.toContain(`${DIR}/agent-manager.token`);
  });

  it("the pane query failing while the manager's window is active: the same", async () => {
    const { made, reads } = withTmux({ TMUX: "x", TMUX_PANE: "%5" });
    const got = await withAgentSettings({}, made, { fillLane: true });
    expect(got.MORNDO_AGENT_TOKEN).not.toBe("fake-manager-token");
    expect(got.MORNDO_LANE).toBeUndefined();
    expect(reads).not.toContain(`${DIR}/agent-manager.token`);
  });

  it("a normal pane still resolves its own lane, the manager's pane the manager's token", async () => {
    const own = (name: string) => async (args: string[]) => (args.includes("-t") && args.includes("%5") ? `${name}\n` : "manager\n");
    for (const [name, token] of [["builder", "fake-lane-token"], ["manager", "fake-manager-token"]] as const) {
      const env = { TMUX: "x", TMUX_PANE: "%5" };
      const m = io(FILES);
      const got = await withAgentSettings({}, { ...m.made, lane: () => laneFromTmux(env, own(name)) }, { fillLane: true });
      expect(got.MORNDO_LANE, name).toBe(name);
      expect(got.MORNDO_AGENT_TOKEN, name).toBe(token);
    }
  });
});

describe("agentSettingsIo says once, on stderr, when tmux cannot tell which lane this is", () => {
  const collect = () => { const lines: string[] = []; return { lines, warn: (line: string) => { lines.push(line); } }; };

  it("in tmux with no TMUX_PANE: one line, however often the lane is asked, and tmux is not started", async () => {
    const w = collect();
    const asked: string[][] = [];
    const real = agentSettingsIo({ HOME: "/h", TMUX: "x" }, async args => { asked.push(args); return "manager\n"; }, w.warn);
    expect(await real.lane()).toBeNull();
    expect(await real.lane()).toBeNull();
    expect(w.lines).toEqual(["TMUX_PANE is not set; cannot tell which lane this is"]);
    expect(asked).toEqual([]);
  });

  it("in tmux with a pane tmux cannot name: one line that says the pane could not be named", async () => {
    const w = collect();
    const real = agentSettingsIo({ HOME: "/h", TMUX: "x", TMUX_PANE: "%5" }, async () => null, w.warn);
    expect(await real.lane()).toBeNull();
    expect(await real.lane()).toBeNull();
    expect(w.lines.length).toBe(1);
    expect(w.lines[0]).toContain("TMUX_PANE");
    expect(w.lines[0]).toContain("cannot tell which lane this is");
    expect(w.lines[0]).not.toContain("is not set");
  });

  it("a pane that resolves, and a command outside tmux, say nothing", async () => {
    const w = collect();
    expect(await agentSettingsIo({ HOME: "/h", TMUX: "x", TMUX_PANE: "%5" }, async () => "builder\n", w.warn).lane()).toBe("builder");
    expect(await agentSettingsIo({ HOME: "/h" }, async () => "manager\n", w.warn).lane()).toBeNull();
    expect(w.lines).toEqual([]);
  });
});

describe("withAgentSettings: the manager's window is the hub's MORNDO_MANAGER_WINDOW", () => {
  it("a renamed manager window gets the manager's token, and the old name no longer does", async () => {
    const boss = io(FILES, "boss");
    expect((await withAgentSettings({ MORNDO_MANAGER_WINDOW: "boss" }, boss.made)).MORNDO_AGENT_TOKEN).toBe("fake-manager-token");
    const old = io(FILES, "manager");
    const got = await withAgentSettings({ MORNDO_MANAGER_WINDOW: "boss" }, old.made);
    expect(got.MORNDO_AGENT_TOKEN).toBe("fake-lane-token");
    expect(old.reads).not.toContain(`${DIR}/agent-manager.token`);
  });

  it("MORNDO_LANE and an empty or blank MORNDO_MANAGER_WINDOW: the default name is manager", async () => {
    expect((await withAgentSettings({ MORNDO_LANE: "boss", MORNDO_MANAGER_WINDOW: "boss" }, io(FILES).made)).MORNDO_AGENT_TOKEN).toBe("fake-manager-token");
    expect((await withAgentSettings({ MORNDO_LANE: "manager", MORNDO_MANAGER_WINDOW: "  " }, io(FILES).made)).MORNDO_AGENT_TOKEN).toBe("fake-manager-token");
  });
});

describe("withAgentSettings: a node name from the file must look like a node name", () => {
  it("a name the memory CLI would refuse is not used, so it falls back to the host name as before", async () => {
    for (const bad of ["Build_PC", "build pc", "-pc", "x".repeat(65)]) {
      const { made } = io({ ...FILES, [`${DIR}/agent-node`]: `${bad}\n` }, "builder");
      expect((await withAgentSettings({}, made)).MORNDO_NODE, bad).toBeUndefined();
    }
    const { made } = io({ ...FILES, [`${DIR}/agent-node`]: "pc-2\n" }, "builder");
    expect((await withAgentSettings({}, made)).MORNDO_NODE).toBe("pc-2");
  });
});

describe("withAgentSettings: it reads and asks only for what is missing", () => {
  it("everything set, no lane: no file is read and the window is not asked", async () => {
    const m = io(FILES, "builder");
    await withAgentSettings({ MORNDO_HUB: "h", MORNDO_NODE: "n", MORNDO_AGENT_TOKEN: "t" }, m.made);
    expect(m.reads).toEqual([]);
    expect(m.state.lanes).toBe(0);
  });

  it("the token set: the window is not asked either, unless the caller wants the lane filled", async () => {
    const quiet = io(FILES, "builder");
    expect((await withAgentSettings({ MORNDO_AGENT_TOKEN: "t" }, quiet.made)).MORNDO_LANE).toBeUndefined();
    expect(quiet.state.lanes).toBe(0);
    const wanted = io(FILES, "builder");
    expect((await withAgentSettings({ MORNDO_AGENT_TOKEN: "t" }, wanted.made, { fillLane: true })).MORNDO_LANE).toBe("builder");
    expect(wanted.state.lanes).toBe(1);
  });

  it("files a command does not use are not read", async () => {
    const m = io(FILES, "builder");
    await withAgentSettings({}, m.made, { skip: ["hub", "node"] });
    expect(m.reads).toEqual([`${DIR}/agent-lanes.token`]);
  });

  it("the window is asked once however often the lane is wanted (one pane query, one time)", async () => {
    const asked: string[][] = [];
    const real = agentSettingsIo({ HOME: "/h", TMUX: "x", TMUX_PANE: "%1" }, async args => { asked.push(args); return null; }, () => {});
    expect(await real.lane()).toBeNull();
    expect(await real.lane()).toBeNull();
    expect(asked).toEqual([["display-message", "-p", "-t", "%1", "#W"]]);
  });
});
