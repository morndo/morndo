// scripts/release/rehearsal/ holds what the release rehearsal (docs/plans/2026-10-24-c4-5-rehearsal.md, step 4, and
// docs/plans/2026-10-27-c4-resume.md, section 3) runs its throwaway machines with: an image (the update-vm machine plus
// curl and ssh-keygen, which install.sh needs), a compose project of three control-plane machines under
// rehearsal.test, a check that reads `docker inspect` of a machine and its network before anything runs in it, and the
// step that hands the bench's feed address to the machine's systemd user manager (the updater reads it there, and
// without it reads production's feed). These tests read the files, and run the two scripts against fixtures shaped as
// Docker Engine 29.8.1 and Compose 5.5.1 answered on 2026-10-27, and against a fake systemctl.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const DIR = fileURLToPath(new URL("./", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHECK = join(DIR, "check-container.sh");
const ENV = join(DIR, "env.sh");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "rehearsal-")); roots.push(d); return d; };

// ---- the image

/** A Dockerfile as its instructions: comments dropped, continuation lines joined. */
function instructions(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trimEnd();
    if (cur === "" && (line.trim() === "" || line.trimStart().startsWith("#"))) continue;
    cur += (cur === "" ? "" : "\n") + line;
    if (!line.endsWith("\\")) { out.push(cur); cur = ""; }
  }
  if (cur !== "") out.push(cur);
  return out;
}
const aptPackages = (ins: string[]): string[] => {
  const apt = ins.find(i => i.startsWith("RUN ") && i.includes("apt-get install"));
  if (apt === undefined) throw new Error("no apt-get install");
  const after = apt.slice(apt.indexOf("--no-install-recommends") + "--no-install-recommends".length);
  return after.split("&&")[0]!.replace(/\\\n/g, " ").split(/\s+/).filter(w => w !== "" && w !== "\\");
};

describe("the rehearsal image", () => {
  const harness = instructions(join(ROOT, "e2e/update-vm/Dockerfile"));
  const image = instructions(join(DIR, "Dockerfile"));

  it("starts from the same base as the update-vm machine", () => {
    expect(image[0]).toBe("FROM ubuntu:24.04");
    expect(harness[0]).toBe("FROM ubuntu:24.04");
  });

  it("installs every package the update-vm machine has, plus curl and openssh-client", () => {
    const pkgs = aptPackages(image);
    for (const p of aptPackages(harness)) expect(pkgs).toContain(p);
    expect(pkgs).toContain("curl");
    expect(pkgs).toContain("openssh-client");
  });

  it("repeats the update-vm machine's other RUN steps, STOPSIGNAL and CMD word for word", () => {
    const others = harness.filter(i => (i.startsWith("RUN ") && !i.includes("apt-get install")) || i.startsWith("STOPSIGNAL ") || i.startsWith("CMD "));
    expect(others.length).toBeGreaterThanOrEqual(4);
    for (const i of others) expect(image).toContain(i);
  });

  it("carries the rehearsal's label and no e2e label a harness sweep would remove it by", () => {
    const text = readFileSync(join(DIR, "Dockerfile"), "utf8");
    expect(image).toContain("LABEL morndo-c4-rehearsal=1");
    expect(text).not.toContain("morndo-c2-e2e");
    expect(text).not.toContain("morndo-c3-fleet-e2e");
    expect(image.filter(i => i.startsWith("FROM "))).toHaveLength(1);
  });
});

// ---- the compose project

describe("the compose project", () => {
  const doc = parse(readFileSync(join(DIR, "compose.yaml"), "utf8")) as Record<string, unknown>;
  const services = doc.services as Record<string, Record<string, unknown>>;

  it("is the project c4-rehearsal with three machines and one network, nothing else", () => {
    expect(Object.keys(doc).sort()).toEqual(["name", "networks", "services"]);
    expect(doc.name).toBe("c4-rehearsal");
    expect(Object.keys(services)).toEqual(["cp1", "cp2", "cp3"]);
    expect(doc.networks).toEqual({ net: { driver: "bridge", labels: { "morndo-c4-rehearsal": "1" } } });
  });

  it.each(["cp1", "cp2", "cp3"])("%s has exactly the controls and nothing that reaches the host", name => {
    const s = services[name]!;
    const { profiles, ...rest } = s;
    expect(rest).toEqual({
      image: "morndo-rehearsal:c4-5",
      hostname: `${name}.rehearsal.test`,
      cgroup: "private",
      cap_add: ["SYS_ADMIN"],
      cap_drop: ["AUDIT_WRITE"],
      environment: { container: "docker" },
      tmpfs: ["/run", "/run/lock", "/tmp"],
      labels: { "morndo-c4-rehearsal": "1" },
      networks: ["net"],
    });
    expect(profiles).toEqual(name === "cp1" ? undefined : [name === "cp2" ? "p7" : "p8"]);
  });
});

// ---- the container check

const GOOD_CONTAINER = {
  Name: "/c4-rehearsal-cp1-1",
  Config: {
    Hostname: "cp1.rehearsal.test",
    Image: "morndo-rehearsal:c4-5",
    Labels: { "com.docker.compose.project": "c4-rehearsal", "com.docker.compose.service": "cp1", "morndo-c4-rehearsal": "1" },
    Env: ["container=docker", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
  },
  HostConfig: {
    Privileged: false,
    CapAdd: ["CAP_SYS_ADMIN"],
    CapDrop: ["CAP_AUDIT_WRITE"],
    Devices: null,
    DeviceCgroupRules: null,
    Binds: null,
    Mounts: null,
    NetworkMode: "c4-rehearsal_net",
    PidMode: "",
    IpcMode: "private",
    UTSMode: "",
    UsernsMode: "",
    CgroupnsMode: "private",
    PortBindings: {},
    PublishAllPorts: false,
    Tmpfs: { "/run": "", "/run/lock": "", "/tmp": "" },
    SecurityOpt: null,
  },
  Mounts: [],
  NetworkSettings: { Ports: {} },
};
const GOOD_NETWORK = {
  Name: "c4-rehearsal_net",
  Driver: "bridge",
  Internal: false,
  Labels: { "com.docker.compose.network": "net", "com.docker.compose.project": "c4-rehearsal", "morndo-c4-rehearsal": "1" },
};
type Json = Record<string, any>;

function check(change: (c: Json, n: Json) => void = () => {}, raw?: { container?: string; network?: string }) {
  const dir = scratch();
  const c = structuredClone(GOOD_CONTAINER) as Json;
  const n = structuredClone(GOOD_NETWORK) as Json;
  change(c, n);
  writeFileSync(join(dir, "c.json"), raw?.container ?? JSON.stringify([c]));
  writeFileSync(join(dir, "n.json"), raw?.network ?? JSON.stringify([n]));
  const r = spawnSync("sh", [CHECK, join(dir, "c.json"), join(dir, "n.json")], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("check-container.sh", () => {
  it("passes the machine compose makes, with Docker's CAP_ names or plain ones", () => {
    const r = check();
    expect(r.code).toBe(0);
    expect(r.out).toContain("check-container: ok (c4-rehearsal-cp1-1 on c4-rehearsal_net");
    expect(r.out).not.toContain("FAIL");
    const plain = check(c => { c.HostConfig.CapAdd = ["SYS_ADMIN"]; c.HostConfig.CapDrop = ["AUDIT_WRITE"]; });
    expect(plain.code).toBe(0);
  });

  it.each<[string, (c: Json, n: Json) => void, string]>([
    ["privileged", c => { c.HostConfig.Privileged = true; }, "FAIL: the container is privileged"],
    ["an extra capability", c => { c.HostConfig.CapAdd = ["CAP_SYS_ADMIN", "CAP_NET_ADMIN"]; }, "FAIL: CapAdd is SYS_ADMIN,NET_ADMIN, not exactly SYS_ADMIN"],
    ["no capability added", c => { c.HostConfig.CapAdd = null; }, "FAIL: CapAdd is none, not exactly SYS_ADMIN"],
    ["AUDIT_WRITE kept", c => { c.HostConfig.CapDrop = []; }, "FAIL: CapDrop is none, not exactly AUDIT_WRITE"],
    ["a device", c => { c.HostConfig.Devices = [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }]; }, "FAIL: the container has devices"],
    ["a device cgroup rule", c => { c.HostConfig.DeviceCgroupRules = ["c 10:232 rwm"]; }, "FAIL: the container has device cgroup rules"],
    ["a bind", c => { c.HostConfig.Binds = ["/home:/home"]; }, "FAIL: the container has bind mounts"],
    ["a mount in HostConfig", c => { c.HostConfig.Mounts = [{ Type: "volume", Source: "data", Target: "/data" }]; }, "FAIL: the container has bind mounts"],
    ["the docker socket", c => { c.Mounts = [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }]; }, "FAIL: the container mounts /var/run/docker.sock (bind)"],
    ["a volume", c => { c.Mounts = [{ Type: "volume", Source: "/var/lib/docker/volumes/x/_data", Destination: "/x" }]; }, "FAIL: the container mounts /var/lib/docker/volumes/x/_data (volume)"],
    ["the host network", c => { c.HostConfig.NetworkMode = "host"; }, "FAIL: the network mode is host, not the rehearsal network c4-rehearsal_net"],
    ["another container's network", c => { c.HostConfig.NetworkMode = "container:abc"; }, "FAIL: the network mode is container:abc, not the rehearsal network c4-rehearsal_net"],
    ["a network that is not a bridge", (_c, n) => { n.Driver = "macvlan"; }, "FAIL: the network c4-rehearsal_net is not a bridge (driver macvlan)"],
    ["a network without the label", (_c, n) => { n.Labels = {}; }, "FAIL: the network c4-rehearsal_net lacks the label morndo-c4-rehearsal=1"],
    ["the host PID namespace", c => { c.HostConfig.PidMode = "host"; }, "FAIL: PidMode is host"],
    ["the host IPC namespace", c => { c.HostConfig.IpcMode = "host"; }, "FAIL: IpcMode is host"],
    ["another container's PID namespace", c => { c.HostConfig.PidMode = "container:abc"; }, "FAIL: PidMode is container:abc"],
    ["the host UTS namespace", c => { c.HostConfig.UTSMode = "host"; }, "FAIL: UTSMode is host"],
    ["the host user namespace", c => { c.HostConfig.UsernsMode = "host"; }, "FAIL: UsernsMode is host"],
    ["the host cgroup namespace", c => { c.HostConfig.CgroupnsMode = "host"; }, "FAIL: CgroupnsMode is host, not private"],
    ["a published port", c => { c.HostConfig.PortBindings = { "8080/tcp": [{ HostIp: "", HostPort: "8080" }] }; }, "FAIL: ports are published"],
    ["all ports published", c => { c.HostConfig.PublishAllPorts = true; }, "FAIL: ports are published"],
    ["a running port mapping", c => { c.NetworkSettings.Ports = { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] }; }, "FAIL: ports are published"],
    ["a security option", c => { c.HostConfig.SecurityOpt = ["apparmor=unconfined"]; }, "FAIL: SecurityOpt is set (apparmor=unconfined)"],
    ["no rehearsal label", c => { delete c.Config.Labels["morndo-c4-rehearsal"]; }, "FAIL: the container lacks the label morndo-c4-rehearsal=1"],
    ["the e2e label", c => { c.Config.Labels["morndo-c2-e2e"] = "1"; }, "FAIL: the container carries the label morndo-c2-e2e, which an e2e sweep removes"],
    ["the fleet e2e label", c => { c.Config.Labels["morndo-c3-fleet-e2e"] = "1"; }, "FAIL: the container carries the label morndo-c3-fleet-e2e, which an e2e sweep removes"],
    ["a real host name", c => { c.Config.Hostname = "srv01"; }, "FAIL: the hostname srv01 is not under rehearsal.test"],
    ["a look-alike host name", c => { c.Config.Hostname = "cp1.rehearsal.test.example.com"; }, "FAIL: the hostname cp1.rehearsal.test.example.com is not under rehearsal.test"],
    ["a MORNDO_ variable", c => { c.Config.Env.push("MORNDO_AGENT_TOKEN=x"); }, "FAIL: the container's environment sets MORNDO_AGENT_TOKEN (the rehearsal sets MORNDO_ variables inside, never through the container)"],
    ["no container=docker", c => { c.Config.Env = ["PATH=/usr/bin:/bin"]; }, "FAIL: the container's environment lacks container=docker"],
    ["another image", c => { c.Config.Image = "morndo-c2-e2e:local"; }, "FAIL: the image is morndo-c2-e2e:local, not morndo-rehearsal:c4-5"],
  ])("fails on %s", (_what, change, line) => {
    const r = check(change);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${line}\n`);
    expect(r.out).not.toContain("check-container: ok");
    expect(r.out).toMatch(/check-container: \d+ problem\(s\)\n$/);
  });

  it("names a secret-looking value in no line it prints", () => {
    const r = check(c => { c.Config.Env.push("MORNDO_AGENT_TOKEN=canary-5f1e0c"); });
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain("canary-5f1e0c");
  });

  it("reports every problem, not only the first", () => {
    const r = check(c => { c.HostConfig.Privileged = true; c.HostConfig.NetworkMode = "host"; });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: the container is privileged\n");
    expect(r.out).toContain("FAIL: the network mode is host, not the rehearsal network c4-rehearsal_net\n");
    expect(r.out).toContain("check-container: 2 problem(s)\n");
  });

  it("refuses input that is not the inspect of exactly one container and one network", () => {
    for (const container of ["", "{}", "[]", JSON.stringify([GOOD_CONTAINER, GOOD_CONTAINER]), "not json"]) {
      const r = check(undefined, { container });
      expect(r.code).toBe(1);
      expect(r.err).toContain("is not the docker inspect of one container");
    }
    const r = check(undefined, { network: "[]" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not the docker inspect of one network");
  });

  it("is a usage error without exactly two files", () => {
    for (const args of [[], ["a"], ["a", "b", "c"]]) {
      const r = spawnSync("sh", [CHECK, ...args], { encoding: "utf8" });
      expect(r.status).toBe(64);
      expect(r.stderr).toContain("check-container: usage: check-container.sh <container-inspect.json> <network-inspect.json>");
    }
  });
});

// ---- the user manager's environment

const BENCH = "https://morndo.github.io/morndo-release-test/";

/** A fake systemctl first on PATH: `--user set-environment K=V` appends to $FAKE_STATE (unless FAKE_SET is "ignore",
 *  or "fail", which exits 1), `--user show-environment` prints it. */
function envRun(args: string[], mode: "ok" | "ignore" | "fail" = "ok") {
  const dir = scratch();
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, "systemctl"), [
    "#!/bin/sh",
    '[ "$1" = --user ] || exit 2',
    "shift",
    'case $1 in',
    '  set-environment) shift; [ "$FAKE_SET" = fail ] && exit 1; [ "$FAKE_SET" = ignore ] && exit 0; for kv in "$@"; do printf \'%s\\n\' "$kv" >> "$FAKE_STATE"; done ;;',
    '  show-environment) printf \'PATH=/usr/bin\\n\'; [ -f "$FAKE_STATE" ] && cat "$FAKE_STATE"; exit 0 ;;',
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "systemctl"), 0o755);
  const r = spawnSync("sh", [ENV, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_STATE: join(dir, "state"), FAKE_SET: mode },
  });
  const conf = join(home, ".config/environment.d/morndo-rehearsal.conf");
  return { code: r.status, out: r.stdout, err: r.stderr, conf: existsSync(conf) ? readFileSync(conf, "utf8") : null };
}

describe("env.sh", () => {
  it("writes the feed address for the user manager, sets it and proves the manager carries it", () => {
    const r = envRun([BENCH]);
    expect(r.code).toBe(0);
    expect(r.conf).toBe(`MORNDO_UPDATE_FEED=${BENCH}\n`);
    expect(r.out).toContain(`rehearsal-env: ok (the user manager carries MORNDO_UPDATE_FEED=${BENCH})`);
  });

  it("adds the trailing slash the updater adds", () => {
    const r = envRun(["https://morndo.github.io/morndo-release-test"]);
    expect(r.code).toBe(0);
    expect(r.conf).toBe(`MORNDO_UPDATE_FEED=${BENCH}\n`);
  });

  it.each(["https://morndo.github.io/morndo/", "https://morndo.github.io/morndo"])("refuses production's feed %s", url => {
    const r = envRun([url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rehearsal-env: that is production's feed; a rehearsal machine never reads it");
    expect(r.conf).toBeNull();
  });

  it.each(["http://morndo.github.io/morndo-release-test/", "morndo.github.io/x/", "file:///etc/"])("refuses %s, which is not https", url => {
    const r = envRun([url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rehearsal-env: the feed address must be an https:// URL");
    expect(r.conf).toBeNull();
  });

  it.each(["https://a.example/x y/", "https://a.example/$HOME/", "https://a.example/\"q\"/", "https://a.example/x\n/"])("refuses an address with a character it may not hold (%j)", url => {
    const r = envRun([url]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rehearsal-env: the feed address holds a character it may not");
    expect(r.conf).toBeNull();
  });

  it("stops when the user manager does not carry it afterwards", () => {
    const r = envRun([BENCH], "ignore");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`rehearsal-env: the user manager does not carry MORNDO_UPDATE_FEED=${BENCH}; stop: the updater would read production's feed`);
  });

  it("stops when systemctl refuses the variable", () => {
    const r = envRun([BENCH], "fail");
    expect(r.code).toBe(1);
    expect(r.err).toContain("rehearsal-env: systemctl --user set-environment failed");
  });

  it("is a usage error without exactly one address", () => {
    for (const args of [[], [BENCH, BENCH]]) {
      const r = envRun(args);
      expect(r.code).toBe(64);
      expect(r.err).toContain("rehearsal-env: usage: env.sh <feed-url>");
    }
  });
});
