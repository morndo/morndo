// The settings a lane's commands need (hub address, node name, agent token, lane name), read from the files under
// ~/.config/morndo when the environment has none. This is what the per-machine wrappers did by hand (T-318, P1). Every
// token here is a made-up string.
import { describe, expect, it } from "vitest";
import { laneFromTmux, withAgentSettings, type AgentEnv, type AgentSettingsIo } from "../src/agent-settings.ts";

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

  it("one set value does not stop the others from being filled", async () => {
    const { made } = io(FILES, "builder");
    const got = await withAgentSettings({ MORNDO_AGENT_TOKEN: "env-token" }, made);
    expect(got.MORNDO_AGENT_TOKEN).toBe("env-token");
    expect(got.MORNDO_HUB).toBe("https://hub.example.test");
    expect(got.MORNDO_NODE).toBe("build-pc");
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

  it("a read that throws is a missing file, and nothing the file held is in any error", async () => {
    const made: AgentSettingsIo = { home: HOME, readText: async () => { throw new Error("EACCES: permission denied, open 'secret-path'"); }, lane: async () => "builder" };
    const got = await withAgentSettings({}, made);
    expect(got.MORNDO_AGENT_TOKEN).toBeUndefined();
  });
});

describe("laneFromTmux asks about the pane the command runs in", () => {
  it("passes -t with TMUX_PANE: the active window of the session is another lane's", async () => {
    const calls: string[][] = [];
    const lane = await laneFromTmux({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%5" }, async args => { calls.push(args); return "builder\n"; });
    expect(lane).toBe("builder");
    expect(calls).toEqual([["display-message", "-p", "-t", "%5", "#W"]]);
  });

  it("outside tmux, or with no pane, tmux is not asked and there is no lane", async () => {
    const calls: string[][] = [];
    const ask = async (args: string[]) => { calls.push(args); return "builder"; };
    expect(await laneFromTmux({}, ask)).toBeNull();
    expect(await laneFromTmux({ TMUX: "x" }, ask)).toBeNull();
    expect(await laneFromTmux({ TMUX_PANE: "%5" }, ask)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a failing or empty answer is no lane", async () => {
    expect(await laneFromTmux({ TMUX: "x", TMUX_PANE: "%5" }, async () => null)).toBeNull();
    expect(await laneFromTmux({ TMUX: "x", TMUX_PANE: "%5" }, async () => "  \n")).toBeNull();
  });
});
