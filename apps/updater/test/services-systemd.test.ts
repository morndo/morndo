// The systemd ServiceManager's contract (design §4.6, §5, §6.2 step 6, RL13): every machine action is one
// `systemctl --user` argument list, scripted here with no real systemd in sight; the restart count probation
// judges is what systemd counted since this adapter's own start, not systemd's lifetime counter; renderUnits
// lands a Version's units whole (temp, rename), drops the Morndo units that Version no longer ships, and
// reloads; and the tmux guard walks a fake control-group tree against a fake /proc — the one thing a unit test
// must never need a real cgroup for.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SystemdServices, systemdUserManager, UNIT_MARK, type Run } from "../src/adapters/services-systemd.ts";
import { ForeignUnits } from "../src/adapters/unit-files.ts";

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

type Answer = { code?: number; stdout?: string; stderr?: string };

// systemctl as a tape: every call recorded, each answer scripted by the test.
class Systemctl {
  readonly calls: { file: string; args: string[] }[] = [];
  reply: (args: string[]) => Answer = () => ({});
  readonly run: Run = async (file, args) => {
    this.calls.push({ file, args });
    const a = this.reply(args);
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
}

// A machine: a home with a units directory, a release tree, and the adapter over a scripted systemctl.
const machine = (o: {
  installed?: string[];                       // unit files a render of ours left in ~/.config/systemd/user
  foreign?: string[];                         // unit files there that Morndo did not write
  releaseUnits?: Record<string, string>;      // <version>/units/<name> → text ("launchd/x" makes a directory)
  reply?: (args: string[]) => Answer;
} = {}) => {
  const home = mkdtempSync(join(scratch, "home-"));
  const units = join(home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  for (const name of o.installed ?? []) writeFileSync(join(units, name), `${UNIT_MARK}\n# installed before\n`);
  for (const name of o.foreign ?? []) writeFileSync(join(units, name), "# a person's own\n[Unit]\n");
  if (o.releaseUnits) {
    const from = join(home, ".local/share/morndo-releases/0.2.0/units");
    mkdirSync(from, { recursive: true });
    for (const [name, text] of Object.entries(o.releaseUnits)) {
      const dest = join(from, name);
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, text);
    }
  }
  const sys = new Systemctl();
  if (o.reply) sys.reply = o.reply;
  return { home, units, sys, manager: new SystemdServices({ home, units, run: sys.run }) };
};

// A fake cgroup tree and a fake /proc: pid lists in <group>/cgroup.procs, process names in <pid>/comm.
const fakeMachine = (o: { procs: Record<string, string[]>; comm: Record<string, string> }) => {
  const root = mkdtempSync(join(scratch, "machine-"));
  const cgroupRoot = join(root, "cgroup");
  const procRoot = join(root, "proc");
  for (const [group, pids] of Object.entries(o.procs)) {
    const dir = join(cgroupRoot, group);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cgroup.procs"), `${pids.join("\n")}\n`);
  }
  for (const [pid, name] of Object.entries(o.comm)) {
    mkdirSync(join(procRoot, pid), { recursive: true });
    writeFileSync(join(procRoot, pid, "comm"), `${name}\n`);
  }
  return { cgroupRoot, procRoot };
};

describe("SystemdServices (§4.6, §5, §6.2 step 6)", () => {
  it("services() names the installed Morndo units, in the domain's order", () => {
    expect(machine({ installed: ["morndo-node.service", "morndo-hub.service"] }).manager.services())
      .toEqual(["hub", "node"]);
    expect(machine().manager.services()).toEqual([]);
  });

  it("stops and starts through systemctl --user, and a failing call throws its stderr", async () => {
    const m = machine();
    await m.manager.stop("hub");
    await m.manager.start("hub");
    expect(m.sys.calls).toEqual([
      { file: "systemctl", args: ["--user", "stop", "morndo-hub.service"] },
      { file: "systemctl", args: ["--user", "start", "morndo-hub.service"] },
      // start records its own baseline right after (restarts is "since our start")
      { file: "systemctl", args: ["--user", "show", "-p", "NRestarts", "--value", "morndo-hub.service"] },
    ]);
    const failing = machine({ reply: a => a.includes("stop")
      ? { code: 1, stderr: "Unit morndo-fleet.service not loaded.\n" } : {} });
    await expect(failing.manager.stop("fleet")).rejects.toThrow(/not loaded/);
  });

  it("restarts() counts what systemd counted since this adapter's own start", async () => {
    let nRestarts = 7;
    const m = machine({ reply: a => a.includes("NRestarts") ? { stdout: `${nRestarts}\n` } : {} });
    await m.manager.start("node");                 // the baseline reads 7
    nRestarts = 9;                                 // two crashes while probation watches (§6.2 step 9)
    await expect(m.manager.restarts("node")).resolves.toBe(2);
  });

  it("restarts() of a service this process never started counts from zero", async () => {
    const m = machine({ reply: a => a.includes("NRestarts") ? { stdout: "4\n" } : {} });
    await expect(m.manager.restarts("fleet")).resolves.toBe(4);
  });

  it("renderUnits lands a Version's units whole, drops what it no longer ships, and reloads", async () => {
    const m = machine({
      installed: ["morndo-hub.service", "morndo-gone.service", "morndo-gone.timer", "unrelated.service",
        ".morndo-gone.service.new"],
      releaseUnits: {
        "morndo-hub.service": "[Unit]\nDescription=hub 0.2.0\n",
        "morndo-update.timer": "[Timer]\nOnBootSec=5min\n",
        "morndo-update-apply@.service": "[Service]\nType=oneshot\n",
        "launchd/com.morndo.hub.plist": "<plist version=\"1.0\"/>\n",   // the launchd half is not systemd's
      },
    });
    await m.manager.renderUnits("0.2.0");
    expect(readdirSync(m.units).sort()).toEqual([
      ".morndo-gone.service.new",         // a crashed render's temp is not one of ours; it stays
      "morndo-hub.service",
      "morndo-update-apply@.service",
      "morndo-update.timer",
      "unrelated.service",                // only Morndo's own files are ever removed
    ]);
    expect(readFileSync(join(m.units, "morndo-hub.service"), "utf8")).toBe(`${UNIT_MARK}\n[Unit]\nDescription=hub 0.2.0\n`);
    expect(m.sys.calls).toEqual([{ file: "systemctl", args: ["--user", "daemon-reload"] }]);
  });

  it("renderUnits adopts the setup before the updater once, keeping each old unit, and its drop-ins stay", async () => {
    // As a machine set up by hand before the updater: the services' units run the checkout's own entry points or the
    // launchers, unmarked; a drop-in sits beside one; another tool's morndo-* unit is not one of our names.
    const m = machine({
      releaseUnits: {
        "morndo-hub.service": "[Unit]\nDescription=hub 0.2.0\n",
        "morndo-node.service": "[Unit]\nDescription=node 0.2.0\n",
        "morndo-update.timer": "[Timer]\nOnBootSec=5min\n",
      },
    });
    const hubBefore = "[Service]\nExecStart=%h/.nvm/versions/node/v24.21.0/bin/node --no-warnings /srv/example-user/code/apps/hub/src/main.ts serve\n";
    const nodeBefore = "[Service]\nExecStart=%h/.local/bin/morndo-node run\n";
    writeFileSync(join(m.units, "morndo-hub.service"), hubBefore);
    writeFileSync(join(m.units, "morndo-node.service"), nodeBefore);
    mkdirSync(join(m.units, "morndo-hub.service.d"));
    writeFileSync(join(m.units, "morndo-hub.service.d/override.conf"), "[Service]\nEnvironment=X=1\n");
    writeFileSync(join(m.units, "morndo-fleet-link.service"), "[Service]\nExecStart=/usr/bin/ssh -N example\n");
    await expect(m.manager.foreignUnits("0.2.0")).resolves.toEqual([]);
    await expect(m.manager.renderUnits("0.2.0")).resolves.toEqual([
      join(m.units, "morndo-hub.service.before-morndo"), join(m.units, "morndo-node.service.before-morndo"),
    ]);
    expect(readFileSync(join(m.units, "morndo-hub.service.before-morndo"), "utf8")).toBe(hubBefore);
    expect(readFileSync(join(m.units, "morndo-node.service.before-morndo"), "utf8")).toBe(nodeBefore);
    expect(readFileSync(join(m.units, "morndo-hub.service"), "utf8")).toBe(`${UNIT_MARK}\n[Unit]\nDescription=hub 0.2.0\n`);
    expect(readFileSync(join(m.units, "morndo-hub.service.d/override.conf"), "utf8")).toBe("[Service]\nEnvironment=X=1\n");
    expect(readFileSync(join(m.units, "morndo-fleet-link.service"), "utf8")).toContain("/usr/bin/ssh");
    // once adopted, the next render has nothing to keep
    await expect(m.manager.renderUnits("0.2.0")).resolves.toEqual([]);
  });

  it("a unit of one of our names running another program is foreign, not legacy", async () => {
    const m = machine({ releaseUnits: { "morndo-hub.service": "[Unit]\n", "morndo-update.service": "[Service]\n" } });
    writeFileSync(join(m.units, "morndo-hub.service"), "[Service]\nExecStart=/usr/bin/python3 /srv/example-user/hub.py\n");
    // an update unit never existed before the updater: unmarked, it is someone else's whatever it runs
    writeFileSync(join(m.units, "morndo-update.service"), "[Service]\nExecStart=%h/.local/bin/morndo-update update tick\n");
    await expect(m.manager.foreignUnits("0.2.0")).resolves.toEqual([join(m.units, "morndo-hub.service"), join(m.units, "morndo-update.service")]);
  });

  it("renderUnits removes only units Morndo wrote, and refuses to overwrite one it did not unless told to keep it aside", async () => {
    const releaseUnits = {
      "morndo-hub.service": "[Unit]\nDescription=hub 0.2.0\n",
      "morndo-update.timer": "[Timer]\nOnBootSec=5min\n",
    };
    // a person's own morndo-* unit that no Version ships: never ours to remove
    const kept = machine({ foreign: ["morndo-mine.service"], releaseUnits });
    await kept.manager.renderUnits("0.2.0");
    expect(readFileSync(join(kept.units, "morndo-mine.service"), "utf8")).toBe("# a person's own\n[Unit]\n");
    // one of a shipped name: refused before anything is written or reloaded
    const m = machine({ foreign: ["morndo-hub.service"], releaseUnits });
    await expect(m.manager.foreignUnits("0.2.0")).resolves.toEqual([join(m.units, "morndo-hub.service")]);
    await expect(m.manager.renderUnits("0.2.0")).rejects.toThrow(ForeignUnits);
    expect(readdirSync(m.units).sort()).toEqual(["morndo-hub.service"]);
    expect(readFileSync(join(m.units, "morndo-hub.service"), "utf8")).toBe("# a person's own\n[Unit]\n");
    expect(m.sys.calls).toEqual([]);
    // replaceForeign keeps it beside the new one first, and says where
    await expect(m.manager.renderUnits("0.2.0", undefined, { replaceForeign: true }))
      .resolves.toEqual([join(m.units, "morndo-hub.service.before-morndo")]);
    expect(readFileSync(join(m.units, "morndo-hub.service.before-morndo"), "utf8")).toBe("# a person's own\n[Unit]\n");
    expect(readFileSync(join(m.units, "morndo-hub.service"), "utf8")).toBe(`${UNIT_MARK}\n[Unit]\nDescription=hub 0.2.0\n`);
    await expect(m.manager.foreignUnits("0.2.0")).resolves.toEqual([]);
  });

  it("refuses to render a Version that ships no units rather than uninstall them", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".local/share/morndo-releases/0.2.0/units"), { recursive: true });
    await expect(m.manager.renderUnits("0.2.0")).rejects.toThrow(/ships no units/);
    expect(m.sys.calls).toEqual([]);     // nothing was reloaded, so nothing changed
  });

  it("tmuxInAgentUnit() walks the node unit's whole control group for a tmux server (RL13)", async () => {
    const f = fakeMachine({
      procs: { "user.slice/morndo-node.service": ["200"], "user.slice/morndo-node.service/lanes": ["300"] },
      comm: { "200": "morndo-node", "300": "tmux: server" },
    });
    const m = machine({ reply: a => a.includes("ControlGroup")
      ? { stdout: "/user.slice/morndo-node.service\n" } : {} });
    const manager = new SystemdServices({ home: m.home, units: m.units, run: m.sys.run,
      cgroupRoot: f.cgroupRoot, procRoot: f.procRoot });
    await expect(manager.tmuxInAgentUnit()).resolves.toBe(true);
    expect(m.sys.calls).toEqual([
      { file: "systemctl", args: ["--user", "show", "-p", "ControlGroup", "--value", "morndo-node.service"] },
    ]);
  });

  it("tmuxInAgentUnit() is false when only the agent's own processes are in the group", async () => {
    const f = fakeMachine({
      procs: { "user.slice/morndo-node.service": ["200"], "user.slice/morndo-node.service/job": ["301"] },
      comm: { "200": "morndo-node", "301": "node" },
    });
    const m = machine({ reply: a => a.includes("ControlGroup")
      ? { stdout: "/user.slice/morndo-node.service\n" } : {} });
    const manager = new SystemdServices({ home: m.home, units: m.units, run: m.sys.run,
      cgroupRoot: f.cgroupRoot, procRoot: f.procRoot });
    await expect(manager.tmuxInAgentUnit()).resolves.toBe(false);
  });

  it("tmuxInAgentUnit() is false when the unit has no control group (not loaded)", async () => {
    const m = machine({ reply: a => a.includes("ControlGroup") ? { stdout: "\n" } : {} });
    await expect(m.manager.tmuxInAgentUnit()).resolves.toBe(false);
  });

  it("runApply starts the apply's own unit for the Version and waits for its end (§6.2)", async () => {
    const m = machine();
    await m.manager.runApply("0.2.0");
    expect(m.sys.calls).toEqual([
      { file: "systemctl", args: ["--user", "start", "morndo-update-apply@0.2.0.service"] },
    ]);
    const failing = machine({ reply: a => a.includes("start")
      ? { code: 1, stderr: "Unit morndo-update-apply@.service not found.\n" } : {} });
    await expect(failing.manager.runApply("0.2.0")).rejects.toThrow(/not found/);
  });

  it("enable is one enable --now for the whole list (§10.3), and an empty list runs nothing", async () => {
    const m = machine();
    await m.manager.enable(["morndo-update.timer", "morndo-hub.service"]);
    expect(m.sys.calls).toEqual([
      { file: "systemctl", args: ["--user", "enable", "--now", "morndo-update.timer", "morndo-hub.service"] },
    ]);
    const quiet = machine();
    await quiet.manager.enable([]);
    expect(quiet.sys.calls).toEqual([]);
  });

  it("lingerEnabled asks loginctl for the user's Linger: yes is yes, anything else is no (§10.3)", async () => {
    const linger = (answer: Answer) => {
      const m = machine({ reply: a => a.includes("show-user") ? answer : {} });
      return { sys: m.sys, manager: new SystemdServices({ home: m.home, units: m.units, run: m.sys.run, user: "worker" }) };
    };
    const yes = linger({ stdout: "yes\n" });
    await expect(yes.manager.lingerEnabled()).resolves.toBe(true);
    expect(yes.sys.calls).toEqual([{ file: "loginctl", args: ["show-user", "worker", "-p", "Linger", "--value"] }]);
    await expect(linger({ stdout: "no\n" }).manager.lingerEnabled()).resolves.toBe(false);
    await expect(linger({ code: 1, stderr: "no such user" }).manager.lingerEnabled()).resolves.toBe(false);
  });

  it("renderUnits with a role ships that role's services with every update unit, and drops the rest (§10.3)", async () => {
    const m = machine({
      installed: ["morndo-fleet.service"],
      releaseUnits: {
        "morndo-hub.service": "[Unit]\nDescription=hub\n",
        "morndo-fleet.service": "[Unit]\nDescription=fleet\n",
        "morndo-node.service": "[Unit]\nDescription=node\n",
        "morndo-update.timer": "[Timer]\nOnBootSec=5min\n",
        "morndo-update-recover.service": "[Unit]\nDescription=recover\n",
      },
    });
    await m.manager.renderUnits("0.2.0", { services: ["node"] });
    expect(readdirSync(m.units).sort()).toEqual([
      "morndo-node.service",
      "morndo-update-recover.service",
      "morndo-update.timer",
    ]);
  });

  it("systemdUserManager asks the manager itself; anything but a zero answer is not this machine's (§4.7)", async () => {
    const tape: { file: string; args: string[] }[] = [];
    const run: Run = async (file, args) => { tape.push({ file, args }); return { code: 0, stdout: "", stderr: "" }; };
    await expect(systemdUserManager(run)).resolves.toBe(true);
    expect(tape).toEqual([{ file: "systemctl", args: ["--user", "show-environment"] }]);
    await expect(systemdUserManager(async () => ({ code: 1, stdout: "", stderr: "" }))).resolves.toBe(false);
    await expect(systemdUserManager(async () => ({ code: 127, stdout: "", stderr: "" }))).resolves.toBe(false);   // no systemctl at all
  });
});
