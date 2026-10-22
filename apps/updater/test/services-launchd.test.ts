// The launchd ServiceManager's contract (design §4.6, §5, U19): a stop is bootout, a start bootstraps the
// plist — kickstart -k when the job is already loaded — restarts come from launchctl print's "runs =" line
// counted from this adapter's own start, and renderUnits writes the real templates with @HOME@ replaced into
// ~/Library/LaunchAgents, as XML a launchd would parse. No macOS in sight: launchctl answers from a script.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchdServices, PLIST_MARK, type Run } from "../src/adapters/services-launchd.ts";
import { ForeignUnits } from "../src/adapters/unit-files.ts";

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

type Answer = { code?: number; stdout?: string; stderr?: string };

// launchctl as a tape, the same way the systemd test scripts systemctl.
class Launchctl {
  readonly calls: { file: string; args: string[] }[] = [];
  reply: (args: string[]) => Answer = () => ({});
  readonly run: Run = async (file, args) => {
    this.calls.push({ file, args });
    const a = this.reply(args);
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
}

// A Mac in miniature: a home with a LaunchAgents directory, a release tree whose units/launchd/ holds either
// the real templates or a fixture's, and the adapter over a scripted launchctl. gui/501 is a made-up uid.
const mac = (o: { installed?: string[]; foreign?: string[]; templates?: "real" | Record<string, string>; reply?: (args: string[]) => Answer } = {}) => {
  const home = mkdtempSync(join(scratch, "home-"));
  const agentsDir = join(home, "Library/LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  for (const name of o.installed ?? []) writeFileSync(join(agentsDir, name), `<?xml version="1.0"?>\n${PLIST_MARK}\n<plist version="1.0"/>\n`);
  for (const name of o.foreign ?? []) writeFileSync(join(agentsDir, name), "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"/>\n");
  if (o.templates) {
    const from = join(home, ".local/share/morndo-releases/0.2.0/units/launchd");
    mkdirSync(from, { recursive: true });
    const source = o.templates === "real"
      ? join(import.meta.dirname, "../units/launchd")
      : null;
    const names = source ? readdirSync(source) : Object.keys(o.templates as Record<string, string>);
    for (const name of names) {
      writeFileSync(join(from, name), source ? readFileSync(join(source, name)) : (o.templates as Record<string, string>)[name]!);
    }
  }
  const lc = new Launchctl();
  if (o.reply) lc.reply = o.reply;
  return { home, agentsDir, lc, manager: new LaunchdServices({ home, run: lc.run, uid: 501, agentsDir }) };
};

const plist = join(import.meta.dirname, "../units/launchd");

describe("LaunchdServices (§4.6, §5)", () => {
  it("services() names the installed Morndo labels, in the domain's order", () => {
    expect(mac({ installed: ["com.morndo.node.plist", "com.morndo.hub.plist"] }).manager.services())
      .toEqual(["hub", "node"]);
    expect(mac().manager.services()).toEqual([]);
  });

  it("stops with bootout, and a failing launchctl throws its stderr", async () => {
    const m = mac();
    await m.manager.stop("hub");
    expect(m.lc.calls).toEqual([{ file: "launchctl", args: ["bootout", "gui/501/com.morndo.hub"] }]);
    const failing = mac({ reply: a => a.includes("bootout")
      ? { code: 3, stderr: "Bootstrap failed: 5: Input/output error\n" } : {} });
    await expect(failing.manager.stop("hub")).rejects.toThrow(/Input\/output error/);
  });

  it("starts a loaded job with kickstart -k, and counts restarts from its own start", async () => {
    let runs = 3;
    const m = mac({ reply: a => a[0] === "print"
      ? { code: 0, stdout: `state = running\n\tlast exit code = 0\n\truns = ${runs}\n` }
      : {} });
    await m.manager.start("hub");                  // the baseline reads runs = 3
    runs = 5;                                      // two more runs while probation watches
    await expect(m.manager.restarts("hub")).resolves.toBe(2);
    expect(m.lc.calls).toEqual([
      { file: "launchctl", args: ["print", "gui/501/com.morndo.hub"] },
      { file: "launchctl", args: ["kickstart", "-k", "gui/501/com.morndo.hub"] },
      { file: "launchctl", args: ["print", "gui/501/com.morndo.hub"] },
      { file: "launchctl", args: ["print", "gui/501/com.morndo.hub"] },
    ]);
  });

  it("starts a job that is not loaded by bootstrapping its plist", async () => {
    const m = mac({ reply: a => a[0] === "print"
      ? { code: 113, stderr: "Could not find service \"com.morndo.hub\" in domain for system\n" }
      : {} });
    await m.manager.start("hub");
    expect(m.lc.calls).toEqual([
      { file: "launchctl", args: ["print", "gui/501/com.morndo.hub"] },
      { file: "launchctl", args: ["bootstrap", "gui/501", join(m.agentsDir, "com.morndo.hub.plist")] },
      { file: "launchctl", args: ["print", "gui/501/com.morndo.hub"] },
    ]);
  });

  it("renderUnits writes the real templates with the home in them, as valid XML, and drops the rest", async () => {
    const m = mac({ installed: ["com.morndo.gone.plist", "unrelated.plist"], templates: "real" });
    await m.manager.renderUnits("0.2.0");
    const written = readdirSync(m.agentsDir).sort();
    expect(written).toEqual([...readdirSync(plist), "unrelated.plist"].sort());
    const hub = readFileSync(join(m.agentsDir, "com.morndo.hub.plist"), "utf8");
    expect(hub).not.toContain("@HOME@");
    expect(hub.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n${PLIST_MARK}\n`)).toBe(true);
    expect(hub).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(hub).toContain('<plist version="1.0">');
    expect(hub).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>/);
    expect(hub).toContain(`<string>${m.home}/.local/bin/morndo</string>`);
    const update = readFileSync(join(m.agentsDir, "com.morndo.update.plist"), "utf8");
    expect(update).toContain(`<string>${m.home}/.local/bin/morndo-update</string>`);
    expect(m.lc.calls).toEqual([]);        // launchd has no daemon-reload: a start bootstraps what it finds
  });

  it("renderUnits removes only plists Morndo wrote, and refuses one of a shipped name it did not write unless told", async () => {
    const m = mac({ foreign: ["com.morndo.hub.plist", "com.morndo.mine.plist"], templates: "real" });
    await expect(m.manager.renderUnits("0.2.0")).rejects.toThrow(ForeignUnits);
    expect(readdirSync(m.agentsDir).sort()).toEqual(["com.morndo.hub.plist", "com.morndo.mine.plist"]);
    await expect(m.manager.renderUnits("0.2.0", undefined, { replaceForeign: true }))
      .resolves.toEqual([join(m.agentsDir, "com.morndo.hub.plist.before-morndo")]);
    expect(readFileSync(join(m.agentsDir, "com.morndo.mine.plist"), "utf8")).not.toContain(PLIST_MARK);   // a person's own, kept
    expect(readFileSync(join(m.agentsDir, "com.morndo.hub.plist"), "utf8")).toContain(PLIST_MARK);
    await expect(m.manager.foreignUnits("0.2.0")).resolves.toEqual([]);
  });

  it("refuses to render a Version that ships no launchd templates rather than uninstall them", async () => {
    const m = mac();
    mkdirSync(join(m.home, ".local/share/morndo-releases/0.2.0/units/launchd"), { recursive: true });
    await expect(m.manager.renderUnits("0.2.0")).rejects.toThrow(/ships no launchd/);
  });

  it("tmuxInAgentUnit() is false: launchd stops a job, not a control group", async () => {
    // There is nothing to guard (§4.6, RL13): launchd has no control group a stop would empty, so the tmux
    // server an agent started does not ride along with the job's own death.
    await expect(mac().manager.tmuxInAgentUnit()).resolves.toBe(false);
  });
});
