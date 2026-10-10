// A synthetic office for the end-to-end checks and for manual QA (e2e/demo-office.ts): a private tmux server with a
// manager, a builder, a reviewer and 16 idle workers, Claude Code session files and transcripts shaped like version
// 2.1.286, a needs-you list shaped like the manager's, and (where TigerVNC is installed) a private VNC desktop with its
// own display, port and password. Nothing here reads or touches the real lanes or the box's shared desktop.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

export function buildOffice(o: { home: string; socket: string; vncPort: number }) {
  const { home: HOME, socket: SOCKET } = o;
  const CLAUDE = join(HOME, "claude");
  const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });

  // ---- synthetic agents: three tmux windows and their Claude Code session files
  tmux("new-session", "-d", "-s", "qa", "-n", "manager", "-x", "120", "-y", "30", "bash --norc --noprofile");
  tmux("new-window", "-t", "qa", "-n", "builder", "bash --norc --noprofile");
  tmux("new-window", "-t", "qa", "-n", "reviewer", "bash --norc --noprofile");
  // Each stands in for an agent, so its prompt is drawn like Claude Code's input box: a ─ rule over "❯" (the hub types
  // only into an input box, tmux.ts inputBoxOnScreen); what is pasted still reaches bash.
  for (const w of ["manager", "builder", "reviewer"]) tmux("send-keys", "-t", `qa:${w}`, "PS1=$'──────\\n❯ '; clear", "Enter");
  // Enough agents and history to overflow every pane, as on a real machine.
  for (let i = 1; i <= 16; i++) tmux("new-window", "-d", "-t", "qa", "-n", `worker-${String(i).padStart(2, "0")}`, "bash --norc --noprofile");
  const panes = Object.fromEntries(tmux("list-panes", "-s", "-t", "qa", "-F", "#{window_name} #{pane_id}").trim().split("\n").map(l => l.split(" ")));

  const t0 = Date.now() - 50 * 60_000;
  const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const L = (o: Record<string, unknown>) => JSON.stringify(o);
  const user = (id: string, min: number, text: string, extra = {}) => L({ type: "user", uuid: id, timestamp: iso(min), origin: { kind: "human" }, message: { role: "user", content: text }, ...extra });
  const said = (id: string, min: number, blocks: unknown[]) => L({ type: "assistant", uuid: id, timestamp: iso(min), message: { role: "assistant", content: blocks } });
  const tool = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
  const text = (t: string) => ({ type: "text", text: t });
  // Files an agent sends and the principal attaches: synthetic, outside the hub's data directory (which it never shares).
  const FILES = mkdtempSync(join(tmpdir(), "morndo-office-files-"));
  const f = (name: string) => join(FILES, name);
  writeFileSync(f("login-before-after.png"), png(320, 160));
  writeFileSync(f("owner-screenshot.png"), png(200, 120, [40, 90, 200]));
  writeFileSync(f("release-notes.md"), "# Release notes\n\n- **CI**: 29 of 29 checks green\n- `npm test`: 14 passed\n\n| Check | Result |\n|---|---|\n| e2e | green |\n");
  writeFileSync(f("build.log"), "build started\ncompiled 128 modules\nbuild finished in 4.2 s\n");
  writeFileSync(f("spec.pdf"), pdf("Login page spec: 14 of 14 tests pass"));
  writeFileSync(f("bundle.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  writeFileSync(f("evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><script>window.__ran = 1</script><rect width="80" height="40" fill="#1f9d63"/></svg>`);
  const tr = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });
  const sendLines = (...names: string[]) => names.map(n => `sent ${f(n)}`).join("\n");
  const transcripts: Record<string, string[]> = {
    manager: [
      L({ type: "ai-title", aiTitle: "Chief of staff for the demo office" }),
      user("m1", 0, "Walk me through each open decision"),
      said("m2", 1, [text("Here are the **three** open decisions:\n\n1. Merge the login page (`#12`)\n2. Switch the demo database\n3. Pick a release day")]),
      said("m3", 2, [tool("t1", "Bash"), tool("t2", "Read"), tool("t3", "Read")]),
      said("m4", 3, [text("STATUS: NEEDS DECISION. The login page is ready; reply `merge 12` and I'll ship it.")]),
      said("mq", 4, [text("[quiet]\n### Studio: retry\n- [x] The second run delivered the research.")]),
      user("ml", 4.5, "[lane-event] Lane events from kira: {\"lane\":\"builder\"}"),
      user("m5", 20, "Manager: builder finished the tests"),
      ...Array.from({ length: 70 }, (_, i) => said(`mf${i}`, 21 + i * 0.2, [text(`Progress note ${i + 1}: still checking the demo release, step ${i + 1} of 70.`)])),
      said("md1", 36, [text("**Demo release:** ready to ship.\n\n- CI: 29 of 29 checks green\n- Review: approved by #reviewer\n- Rollback: one command, tested\n\nShip it tonight, or hold for a day?\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day | ask=Ask the reviewer first")]),
    ],
    builder: [
      L({ type: "ai-title", aiTitle: "Build the login page" }),
      user("b1", 5, "Manager: build the login page with tests"),
      said("b2", 6, [text("Starting with the form and its validation.")]),
      said("b3", 7, [tool("t4", "Edit"), tool("t5", "Edit"), tool("t6", "Bash")]),
      said("b4", 30, [text("STATUS: DONE. The login page is built and 14 of 14 tests pass.\n\n```\nnpm test  →  14 passed\n```")]),
      said("b5", 31, [{ type: "tool_use", id: "s1", name: "Bash", input: { command: `lanes sendfile ${f("login-before-after.png")} "The login page, before and after" && lanes sendfile ${f("release-notes.md")} "Release notes"` } }]),
      L({ type: "user", uuid: "b6", timestamp: iso(31.1), message: { role: "user", content: [tr("s1", sendLines("login-before-after.png", "release-notes.md"))] } }),
      said("b7", 32, [{ type: "tool_use", id: "s2", name: "Bash", input: { command: `for x in build.log spec.pdf bundle.bin evil.svg gone.png; do lanes sendfile "$D/$x"; done` } }]),
      L({ type: "user", uuid: "b8", timestamp: iso(32.1), message: { role: "user", content: [tr("s2", sendLines("build.log", "spec.pdf", "bundle.bin", "evil.svg", "gone.png"))] } }),
    ],
    reviewer: [
      L({ type: "ai-title", aiTitle: "Review change 12" }),
      user("r1", 10, "Manager: review change 12"),
      user("r1b", 11, `This is what I see on my phone\n\n[The owner attached a file: ${f("owner-screenshot.png")}]`),
      said("r2", 40, [text("Two findings so far. One needs your call."), { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Keep the old endpoint for one more release?", header: "Endpoint", multiSelect: false, options: [{ label: "Keep it", description: "Remove it in the next release" }, { label: "Remove now", description: "Clients on the old version break" }] }] } }]),
    ],
  };
  mkdirSync(join(CLAUDE, "sessions"), { recursive: true });
  mkdirSync(join(CLAUDE, "projects", "-qa"), { recursive: true });
  Object.entries(transcripts).forEach(([name, lines], i) => {
    writeFileSync(join(CLAUDE, "sessions", `${i}.json`), JSON.stringify({ pid: process.pid, sessionId: `s-${name}`, tmux: `qa:@${i}.${panes[name]}`, name: `${name}-e2`, cwd: `/work/${name}`, version: "2.1.286", updatedAt: 1 }));
    writeFileSync(join(CLAUDE, "projects", "-qa", `s-${name}.jsonl`), lines.join("\n") + "\n");
  });

  // The manager's needs-you list, synthetic: a blocking decision with buttons, one answered in words, a time item, and
  // one already closed.
  const LEDGER = join(HOME, "ledger.json");
  const LOCK = join(HOME, "pane.lock");
  writeFileSync(LOCK, "");
  const dayOf = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const ledger = {
    needsYou: [
      { id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold until tomorrow", deadline: dayOf(0), blocking: true, task: "demo-release",
        recommendation: "Ship it: CI is green, the reviewer approved, and rollback is one command.", ts: iso(35) },
      { id: "ny-8", kind: "tap", question: "Which day should the launch post go out?", default: "next Monday", deadline: dayOf(3), ts: iso(20) },
      { id: "ny-9", kind: "time", item: "Sign the venue contract (about 10 minutes, needs your signature)", default: "not signed", deadline: dayOf(1), added: iso(10) },
    ],
    needsYouClosed: [{ id: "ny-5", kind: "tap", question: "Rename the staging bucket?", status: "answered", answer: "Renamed to demo-staging", closedAt: iso(30) }],
  };
  const writeLedger = (doc: unknown) => writeFileSync(LEDGER, typeof doc === "string" ? doc : JSON.stringify(doc));
  writeLedger(ledger);

  const desktop = privateDesktop(HOME, o.vncPort);
  return {
    tmux, panes, ledger, writeLedger, line: L, claudeDir: CLAUDE, desktop,
    env: (port: number) => ({
      MORNDO_LEDGER: LEDGER, MORNDO_PANE_LOCK: LOCK, MORNDO_HOME: HOME, MORNDO_PORT: String(port), MORNDO_ORIGIN: `http://localhost:${port}`,
      MORNDO_TMUX_SOCKET: SOCKET, MORNDO_CLAUDE_DIR: CLAUDE, MORNDO_OFFICE_NAME: "Demo office", MORNDO_POLL_MS: "400",
      ...(desktop ? { MORNDO_VNC: `127.0.0.1:${desktop.port}`, MORNDO_VNC_PASSWORD_FILE: desktop.passwordFile } : {}),
      MORNDO_INBOX: join(FILES, "inbox"),
    }),
    stop: () => { desktop?.stop(); try { tmux("kill-server"); } catch { /* gone */ } rmSync(FILES, { recursive: true, force: true }); },
    files: FILES,
  };
}

// A private TigerVNC desktop, 1024x640, with an orange background so a test can see real pixels arrive.
function privateDesktop(home: string, port: number) {
  if (!existsSync("/usr/bin/Xtigervnc") || !existsSync("/usr/bin/vncpasswd")) return null;
  const passwordFile = join(home, "vncpasswd");
  writeFileSync(passwordFile, execFileSync("vncpasswd", ["-f"], { input: "demo-vnc\n" }));
  let display = 150 + (process.pid % 40);
  while (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) display++;
  const server: ChildProcess = spawn("Xtigervnc", [`:${display}`, "-rfbport", String(port), "-localhost=1", "-SecurityTypes", "VncAuth",
    "-PasswordFile", passwordFile, "-geometry", "1024x640", "-AlwaysShared=1"], { stdio: "ignore" });
  const env = { ...process.env, DISPLAY: `:${display}` };
  for (let i = 0; i < 50; i++) {
    try { execFileSync("xsetroot", ["-solid", "#ff8800"], { env, stdio: "ignore" }); break; }
    catch { execFileSync("sleep", ["0.1"]); }
  }
  return {
    display, port, passwordFile, env,
    // A dialog that closes on Enter (its default button): proof that keys reached the desktop.
    dialog: () => spawn("xmessage", ["-center", "-default", "OK", "-buttons", "OK:0", "Morndo desktop check"], { env, stdio: "ignore" }),
    stop: () => server.kill("SIGTERM"),
  };
}

// A real PNG (RGB, a two-color diagonal), so the browser decodes it: proof the bytes arrived intact.
function png(w: number, h: number, a = [240, 161, 80], b = [21, 26, 58]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = x / w + y / h < 1 ? a : b;
    rows.set(c as number[], y * (w * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// A minimal valid PDF (one page, one line of text) with a correct cross-reference table, so a real viewer opens it.
function pdf(line: string): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 16 Tf 24 80 Td (${line.replace(/[()\\]/g, "")}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
