// The fleet's settings: defaults without a file, the file over the defaults, and a clear refusal for a file that
// doesn't fit (a typo never falls back to a default silently).
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, HOOK_PATHS, configPath, homeOf, loadConfig } from "../src/config.ts";
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
    ];
    for (const [content, message] of cases) {
      const { home, env } = withFile(content);
      expect(() => loadConfig({ env, home }), JSON.stringify(content)).toThrow(ConfigError);
      expect(() => loadConfig({ env, home }), JSON.stringify(content)).toThrow(message);
    }
  });
});
