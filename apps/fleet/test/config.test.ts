// The fleet's settings: defaults without a file, the file over the defaults, and a clear refusal for a file that
// doesn't fit (a typo never falls back to a default silently).
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, HOOK_PATHS, configPath, homeOf, loadConfig, workerSocketOf } from "../src/config.ts";
import { tempDir } from "./helpers/temp.ts";

const withFile = (content: unknown) => {
  const home = tempDir();
  const file = join(home, "fleet.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return { home, env: { MORNDO_FLEET_CONFIG: file } };
};

describe("fleet config", () => {
  it("runs on defaults when there is no file", () => {
    const home = tempDir();
    expect(configPath({}, home)).toBe(join(home, ".config/morndo-fleet/config.json"));
    expect(loadConfig({ env: {}, home })).toEqual({
      listen: { host: "127.0.0.1", port: 8791 },
      socketPath: join(home, ".local/state/morndo-fleet/fleet.sock"),
      dbPath: join(home, ".local/share/morndo-fleet/fleet.db"),
      keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
      publicUrl: "ws://127.0.0.1:8791/agent",
      subscribers: [],
      stickyLanes: ["manager"],
      laneEvents: { deliverTo: "manager", header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 },
      laneWatch: { waitingMin: 30, noStatusMin: 15, nudge: true },
    });
  });

  it("takes its home from HOME, a HOME set but empty counting as unset, and never from XDG_*", () => {
    const home = tempDir();
    expect(configPath({ HOME: home, XDG_CONFIG_HOME: "/elsewhere" })).toBe(join(home, ".config/morndo-fleet/config.json"));
    expect(homeOf({ HOME: "" })).toBe(homedir());                                     // never "" (a relative path)
    expect(loadConfig({ env: { HOME: home, XDG_STATE_HOME: "/elsewhere", XDG_DATA_HOME: "/elsewhere" } }).dbPath).toBe(join(home, ".local/share/morndo-fleet/fleet.db"));
  });

  it("takes the file's settings over the defaults and expands ~/", () => {
    const { home, env } = withFile({
      listen: { host: "127.0.0.1", port: 0 }, socketPath: "~/run/f.sock", publicUrl: "wss://fleet.example.test/agent",
      subscribers: [{ name: "kira", url: "http://127.0.0.1:8788/hooks", paths: ["/hook/stop", "/cc", "/cc"] }],
    });
    const c = loadConfig({ env, home });
    expect(c.listen).toEqual({ host: "127.0.0.1", port: 0 });
    expect(c.socketPath).toBe(join(home, "run/f.sock"));
    expect(c.dbPath).toBe(join(home, ".local/share/morndo-fleet/fleet.db"));
    expect(c.publicUrl).toBe("wss://fleet.example.test/agent");
    expect(c.subscribers).toEqual([{ name: "kira", url: "http://127.0.0.1:8788/hooks", paths: ["/hook/stop", "/cc"] }]);
    expect(HOOK_PATHS).toEqual(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"]);
  });

  it("takes a loopback listen address and a ws:// URL to this machine, or any wss:// URL", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) {
      const { home, env } = withFile({ listen: { host, port: 8791 } });
      expect(loadConfig({ env, home }).listen.host).toBe(host);
    }
    for (const publicUrl of ["ws://127.0.0.1:8791/agent", "ws://localhost:8791/agent", "ws://[::1]:8791/agent", "wss://fleet.tail1234.ts.net/agent"]) {
      const { home, env } = withFile({ publicUrl });
      expect(loadConfig({ env, home }).publicUrl).toBe(publicUrl);
    }
  });

  it("takes the sticky lane names from the file, each once; none at all is allowed", () => {
    for (const [stickyLanes, expected] of [[["manager", "ops lead", "manager"], ["manager", "ops lead"]], [[], []]] as const) {
      const { home, env } = withFile({ stickyLanes });
      expect(loadConfig({ env, home }).stickyLanes).toEqual(expected);
    }
  });

  it("takes laneEvents' settings one by one over their defaults; the owner's header and globs as they are", () => {
    const header = "[lane-event] Lane events from kira (handle them as the Dispatching work section says):";
    const { home, env } = withFile({ laneEvents: { header, ignore: ["pooltest*", "pool-probe*"] } });
    expect(loadConfig({ env, home }).laneEvents).toEqual({ deliverTo: "manager", header, ignore: ["pooltest*", "pool-probe*"], batchMs: 3000 });
    const off = withFile({ laneEvents: { deliverTo: null, batchMs: 100 } });
    expect(loadConfig(off).laneEvents).toMatchObject({ deliverTo: null, batchMs: 100 });
  });

  it("takes laneWatch's settings one by one over their defaults (reliable lanes §3.2)", () => {
    expect(loadConfig(withFile({ laneWatch: { noStatusMin: 5 } })).laneWatch).toEqual({ waitingMin: 30, noStatusMin: 5, nudge: true });
    expect(loadConfig(withFile({ laneWatch: { waitingMin: 1440, nudge: false } })).laneWatch).toEqual({ waitingMin: 1440, noStatusMin: 15, nudge: false });
  });

  it("takes the principal's pinned public key, and stays closed without one (updates §5.4)", () => {
    expect(loadConfig(withFile({})).principalKey).toBeUndefined();
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(loadConfig(withFile({ principalKey: key })).principalKey).toBe(key);
  });

  it("workerSocket defaults: a socket beside the owner's, the sticky and event lanes protected, no node to start on", () => {
    const home = tempDir();
    const c = loadConfig({ env: {}, home });
    expect(c.workerSocket).toBeUndefined();                       // absent from the file and from the defaults: derived, so nothing else changes
    expect(workerSocketOf(c)).toEqual({ path: join(home, ".local/state/morndo-fleet/fleet-worker.sock"), protectedLanes: ["manager"], startNodes: [] });
    const own = loadConfig(withFile({ socketPath: "~/run/own.sock", stickyLanes: ["manager", "chief"], laneEvents: { deliverTo: "scribe" } }));
    expect(workerSocketOf(own).path.endsWith("/run/fleet-worker.sock")).toBe(true);
    expect(workerSocketOf(own).protectedLanes).toEqual(["manager", "chief", "scribe"]);
  });

  it("workerSocket settings: path, protectedLanes and startNodes are taken one by one", () => {
    const home = tempDir();
    const f = withFile({ workerSocket: { path: join(home, "w.sock"), protectedLanes: ["a b", "c"], startNodes: ["pc", "srv01"] } });
    expect(workerSocketOf(loadConfig(f))).toEqual({ path: join(home, "w.sock"), protectedLanes: ["manager", "a b", "c"], startNodes: ["pc", "srv01"] });   // the file's lanes add to the defaults
    const partial = workerSocketOf(loadConfig(withFile({ workerSocket: { startNodes: ["pc"] } })));
    expect(partial.startNodes).toEqual(["pc"]);
    expect(partial.protectedLanes).toEqual(["manager"]);
  });

  it("workerSocket.protectedLanes never removes a default: [] and another name leave the sticky and event lanes protected", () => {
    expect(workerSocketOf(loadConfig(withFile({ workerSocket: { protectedLanes: [] } }))).protectedLanes).toEqual(["manager"]);
    expect(workerSocketOf(loadConfig(withFile({ workerSocket: { protectedLanes: ["x"] } }))).protectedLanes).toEqual(["manager", "x"]);
    const own = loadConfig(withFile({ stickyLanes: ["chief"], laneEvents: { deliverTo: "scribe" }, workerSocket: { protectedLanes: ["scribe", "x"] } }));
    expect(workerSocketOf(own).protectedLanes).toEqual(["chief", "scribe", "x"]);
  });

  it("workerSocket refuses unknown keys, relative paths, a path equal to the owner's and bad names", () => {
    const home = tempDir();
    const cases: [unknown, RegExp][] = [
      [{ workerSocket: [] }, /workerSocket must be an object/],
      [{ workerSocket: { paths: "x" } }, /workerSocket has unknown settings: paths/],
      [{ workerSocket: { path: "rel/w.sock" } }, /workerSocket.path must be absolute/],
      [{ socketPath: join(home, "f.sock"), workerSocket: { path: join(home, "f.sock") } }, /workerSocket.path must differ from socketPath/],
      [{ workerSocket: { protectedLanes: "manager" } }, /workerSocket.protectedLanes must be a list of lane names/],
      [{ workerSocket: { startNodes: ["Bad Node"] } }, /workerSocket.startNodes must be a list of node names/],
      [{ workerSocket: { startNodes: "pc" } }, /workerSocket.startNodes must be a list of node names/],
    ];
    for (const [content, message] of cases) {
      const { home: h, env } = withFile(content);
      expect(() => loadConfig({ env, home: h }), JSON.stringify(content)).toThrow(message);
    }
  });

  it("refuses a file that doesn't fit, naming the setting", () => {
    const cases: [unknown, RegExp][] = [
      ["{not json", /not valid JSON/],
      [[1, 2], /JSON object/],
      [{ lisen: {} }, /unknown settings: lisen/],
      [{ listen: { host: "127.0.0.1", port: 70000 } }, /listen/],
      [{ listen: { host: "0.0.0.0", port: 8791 } }, /listen.host must be a loopback address/],             // negative control: plain on the network
      [{ listen: { host: "100.64.0.7", port: 8791 } }, /listen.host must be a loopback address/],
      [{ publicUrl: "ws://100.64.0.7:8791/agent" }, /publicUrl must be wss:\/\/, or ws:\/\/ to this machine/],   // negative control: clear text off the machine
      [{ publicUrl: "ws://localhost.example.test/agent" }, /publicUrl must be wss:\/\/, or ws:\/\/ to this machine/],
      [{ dbPath: "relative/fleet.db" }, /dbPath must be absolute/],
      [{ publicUrl: "http://x/agent" }, /publicUrl must start with ws: or wss:/],
      [{ publicUrl: "wss://flëet.example.test/agent" }, /publicUrl must be printable ASCII/],
      [{ subscribers: {} }, /subscribers must be a list/],
      [{ subscribers: [{ name: "Kira", url: "http://x/", paths: ["/cc"] }] }, /name must match/],
      [{ subscribers: [{ name: "kira", url: "ftp://x/", paths: ["/cc"] }] }, /url must start with http: or https:/],
      [{ subscribers: [{ name: "kira", url: "http://x/", paths: [] }] }, /paths must list at least one/],
      [{ subscribers: [{ name: "kira", url: "http://x/", paths: ["/everything"] }] }, /"\/everything" is not one of/],
      [{ subscribers: [{ name: "kira", url: "http://x/", paths: ["/cc"], secret: "x" }] }, /unknown settings: secret/],
      [{ subscribers: [{ name: "a", url: "http://x/", paths: ["/cc"] }, { name: "a", url: "http://y/", paths: ["/cc"] }] }, /used twice/],
      [{ stickyLanes: "manager" }, /stickyLanes must be a list of lane names/],
      [{ stickyLanes: [""] }, /stickyLanes must be a list of lane names/],
      [{ stickyLanes: ["man\nager"] }, /stickyLanes must be a list of lane names/],
      [{ laneEvents: [] }, /laneEvents must be an object/],
      [{ laneWatch: [] }, /laneWatch must be an object/],
      [{ laneWatch: { nudges: true } }, /laneWatch has unknown settings: nudges/],
      [{ laneWatch: { noStatusMin: 0 } }, /laneWatch.noStatusMin must be a whole number of minutes from 1 to 1440/],
      [{ laneWatch: { waitingMin: 1.5 } }, /laneWatch.waitingMin must be a whole number of minutes/],
      [{ laneWatch: { nudge: "yes" } }, /laneWatch.nudge must be true or false/],
      [{ laneEvents: { deliver: "manager" } }, /laneEvents has unknown settings: deliver/],
      [{ laneEvents: { deliverTo: "" } }, /laneEvents.deliverTo must be a lane name, or null/],
      [{ laneEvents: { header: "two\nlines" } }, /laneEvents.header must be one line/],
      [{ laneEvents: { ignore: "pooltest*" } }, /laneEvents.ignore must be a list of lane names/],
      [{ laneEvents: { batchMs: 10 } }, /laneEvents.batchMs must be a whole number of milliseconds from 100 to 60000/],
      [{ principalKey: "" }, /principalKey must be the hub's public key/],
      [{ principalKey: Buffer.alloc(31, 7).toString("base64") }, /principalKey must be 32 bytes.*this is 31/],
    ];
    for (const [content, message] of cases) {
      const { home, env } = withFile(content);
      expect(() => loadConfig({ env, home }), JSON.stringify(content)).toThrow(ConfigError);
      expect(() => loadConfig({ env, home }), JSON.stringify(content)).toThrow(message);
    }
  });
});
