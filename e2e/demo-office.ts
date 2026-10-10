// Manual QA: the synthetic office (e2e/office.ts) with its own hub, kept running until Ctrl+C. Prints a one-time pairing
// link for a browser on this machine. Synthetic data only; the real lanes are never read.
// Run: npm run build && node e2e/demo-office.ts [port]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOffice } from "./office.ts";

const port = Number(process.argv[2] ?? 8799);
const home = mkdtempSync(join(tmpdir(), "morndo-demo-"));
const socket = `morndo-demo-${process.pid}`;
const office = buildOffice({ home, socket, vncPort: port + 1 });
const env = { ...process.env, ...office.env(port) };
const hubMain = join(import.meta.dirname, "../apps/hub/src/main.ts");
const hub = spawn(process.execPath, ["--no-warnings", hubMain, "serve"], { env, stdio: ["ignore", "pipe", "inherit"] });
hub.stdout.pipe(process.stdout);
// `pair` only once the hub listens: a second process opening the database while the hub still sets it up got
// "database is locked" (a fixed 1.5 s wait lost that race under load).
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("the demo hub didn't start in 60 s")), 60_000);
  hub.stdout.on("data", (d: Buffer) => { if (String(d).includes("morndo hub on")) { clearTimeout(t); resolve(); } });
  hub.once("exit", c => { clearTimeout(t); reject(new Error(`the demo hub exited ${c}`)); });
});
const pair = execFileSync(process.execPath, ["--no-warnings", hubMain, "pair"], { env, encoding: "utf8" }).split("\n").find(l => l.includes("/pair#t="))?.trim();
console.log(`\ndemo office on http://localhost:${port}\npair: ${pair}\nledger: ${join(home, "ledger.json")} (edit it to see the panel follow)\ntmux: tmux -L ${socket} attach\ndesktop: ${office.desktop ? `DISPLAY=:${office.desktop.display} (VNC port ${office.desktop.port})` : "none (no TigerVNC)"}\n`);

const stop = () => {
  hub.kill("SIGTERM");
  office.stop();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
