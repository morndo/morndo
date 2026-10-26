// Sinks of a key pool (ADR-0037, slice 4; KP20): the files a server's key is written to by `write-env`. A sink is registered by the principal, is an
// absolute normalised path of safe characters, and is unique within the pool; it is kept in the saved body and in no event. Pure, `now` is the clock.
import { describe, expect, it } from "vitest";
import {
  addKey, addKeySink, createKeyPool, emptyDirectory, findConnection, isSinkPath, joinKeyPool, removeKeySink, sinkFiles, sinkSidecar,
  KEY_POOL_SINKS_MAX, KEY_POOL_RETIRED_MAX,
  type Actor, type Connection, type KeyPool,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const principal: Actor = { kind: "principal", command: "c1" };
const lane: Actor = { kind: "operator" };
const PATH = "/srv/app/.env";

function ok<V>(r: { ok: true; value: V } | { ok: false; error: unknown }): V {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}
const word = (r: { ok: boolean; error?: unknown }): string => (r.ok ? "ok" : String(r.error));

function pool(): KeyPool {
  let dir = emptyDirectory();
  for (const name of ["k1", "k2"]) {
    dir = ok(addKey(dir, {
      name, vendor: "v", runtime: "r", isolation: "rules", floor: "rules", ref: `ref-${name}`, fingerprint: name === "k1" ? "0123456789ab" : "ba9876543210",
      billing: "metered", budget: { kind: "unlimited" }, expiry: null,
    }, principal, T));
  }
  let p = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v", policy: { mode: "round-robin", recheckEveryMs: DAY } }, { connections: ["k1", "k2"], pools: [], deleted: [] }, principal, T));
  for (const name of ["k1", "k2"]) p = ok(joinKeyPool(p, findConnection(dir, name) as Connection, { elsewhere: [] }, null, true, principal, T));
  return p;
}

describe("kp20 a sink is an absolute, normalised path of safe characters", () => {
  it.each(["/srv/app/.env", "/srv/svc/app.env", "/etc/app/env-file_1", "/a", "/opt/x/y/z.env", "/srv/a@b/c+d=e,f:g"])("accepts %s", path => {
    expect(isSinkPath(path)).toBe(true);
  });
  it.each([
    ["relative", "srv/app/.env"], ["empty", ""], ["root", "/"], ["a trailing slash", "/srv/app/"], ["a double slash", "/srv//app"],
    ["a dot segment", "/srv/./app"], ["a parent segment", "/srv/../etc/passwd"], ["a trailing parent", "/srv/app/.."],
    ["a space", "/srv/my app/.env"], ["a newline", "/srv/app\n/.env"], ["a NUL", "/srv/app\0/.env"], ["a star", "/srv/*/.env"],
    ["a question mark", "/srv/?/.env"], ["brackets", "/srv/[a]/.env"], ["braces", "/srv/{a,b}/.env"], ["parentheses", "/srv/(a)/.env"],
    ["a quote", "/srv/'a'/.env"], ["a backslash", "/srv/a\\b"], ["a tilde", "~/app/.env"], ["a dollar", "/srv/$HOME/.env"],
    ["over 4096 characters", `/${"a".repeat(4096)}`], ["the sidecar of another file", "/srv/app/.env.member"],
    ["the temp file of another file", "/srv/app/.env.tmp"], ["the lock of another file", "/srv/app/.env.lock"],
  ])("refuses %s", (_name, path) => {
    expect(isSinkPath(path)).toBe(false);
    expect(word(addKeySink(pool(), path, principal, T))).toBe("bad_path");
  });
  it("the sidecar of a sink is the path with .member, and is itself never a sink", () => {
    expect(sinkSidecar(PATH)).toBe("/srv/app/.env.member");
    expect(isSinkPath(sinkSidecar(PATH))).toBe(false);
  });
});

describe("sinkFiles: every file a write can leave a key in", () => {
  it("the file, its sidecar and its temp file", () => {
    expect(sinkFiles(PATH)).toEqual([PATH, "/srv/app/.env.member", "/srv/app/.env.tmp"]);
  });
});

describe("kp20 a sink is the principal's", () => {
  it("an operator may neither add nor remove one", () => {
    const p = ok(addKeySink(pool(), PATH, principal, T));
    expect(word(addKeySink(pool(), PATH, lane, T))).toBe("principal");
    expect(word(removeKeySink(p, PATH, lane, T))).toBe("principal");
    expect(p.sinks).toEqual([PATH]);
  });
  it("a principal with no command id is refused too", () => {
    expect(word(addKeySink(pool(), PATH, { kind: "principal", command: " " }, T))).toBe("principal");
  });
});

describe("sinks in the pool", () => {
  it("a new pool has none; add keeps them in order, once each", () => {
    expect(pool().sinks).toEqual([]);
    let p = ok(addKeySink(pool(), PATH, principal, T));
    p = ok(addKeySink(p, "/srv/other/.env", principal, T));
    expect(p.sinks).toEqual([PATH, "/srv/other/.env"]);
    expect(word(addKeySink(p, PATH, principal, T))).toBe("exists");
  });
  it("at most KEY_POOL_SINKS_MAX (16) per pool", () => {
    expect(KEY_POOL_SINKS_MAX).toBe(16);
    let p = pool();
    for (let i = 0; i < KEY_POOL_SINKS_MAX; i++) p = ok(addKeySink(p, `/srv/s${i}/.env`, principal, T));
    expect(word(addKeySink(p, "/srv/more/.env", principal, T))).toBe("too_many");
  });
  it("remove takes one out; one that is not there is missing", () => {
    let p = ok(addKeySink(pool(), PATH, principal, T));
    p = ok(removeKeySink(p, PATH, principal, T));
    expect(p.sinks).toEqual([]);
    expect(word(removeKeySink(p, PATH, principal, T))).toBe("missing");
  });
  it("a sink is in the saved body (a round trip through JSON keeps it)", () => {
    const p = ok(addKeySink(pool(), PATH, principal, T));
    expect((JSON.parse(JSON.stringify(p)) as KeyPool).sinks).toEqual([PATH]);
  });
  it("a sink path is in no event: they carry the count and the command id", () => {
    let p = ok(addKeySink(pool(), PATH, principal, T));
    p = ok(removeKeySink(p, PATH, principal, T + 1));
    const events = p.events.filter(e => e.type === "SinkAdded" || e.type === "SinkRemoved");
    expect(events).toEqual([
      { type: "SinkAdded", sinks: 1, at: T, command: "c1" },
      { type: "SinkRemoved", sinks: 0, at: T + 1, command: "c1" },
    ]);
    expect(JSON.stringify(p.events)).not.toContain(PATH);
  });
});

describe("kp20 a sink that is removed still holds a key until its file is gone", () => {
  it("remove moves the path to retired, with its registration time dropped; adding it again takes it out of retired", () => {
    let p = ok(addKeySink(pool(), PATH, principal, T));
    expect(p.sinkSince).toEqual({ [PATH]: T });
    p = ok(removeKeySink(p, PATH, principal, T + 1));
    expect([p.sinks, p.retired, p.sinkSince]).toEqual([[], [PATH], {}]);
    p = ok(addKeySink(p, PATH, principal, T + 2));
    expect([p.sinks, p.retired, p.sinkSince]).toEqual([[PATH], [], { [PATH]: T + 2 }]);
  });
  it("a new pool has none retired; a path retired once is kept once; at most KEY_POOL_RETIRED_MAX, the newest kept", () => {
    expect(pool().retired).toEqual([]);
    expect(KEY_POOL_RETIRED_MAX).toBe(64);
    let p = pool();
    for (let i = 0; i < KEY_POOL_RETIRED_MAX + 5; i++) {
      p = ok(addKeySink(p, `/srv/r${i}/.env`, principal, T));
      p = ok(removeKeySink(p, `/srv/r${i}/.env`, principal, T));
    }
    expect(p.retired).toHaveLength(KEY_POOL_RETIRED_MAX);
    expect(p.retired.at(-1)).toBe(`/srv/r${KEY_POOL_RETIRED_MAX + 4}/.env`);
    expect(p.retired).not.toContain("/srv/r0/.env");
  });
  it("retired paths and registration times are in the saved body, and in no event", () => {
    let p = ok(addKeySink(pool(), PATH, principal, T));
    p = ok(removeKeySink(p, PATH, principal, T + 1));
    expect((JSON.parse(JSON.stringify(p)) as KeyPool).retired).toEqual([PATH]);
    expect(JSON.stringify(p.events)).not.toContain(PATH);
  });
});
