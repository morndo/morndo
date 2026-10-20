// A launcher around the real work, as some CLIs are: it starts slow-runtime.mjs (which ignores SIGTERM) as an inner process and
// leaves at once on SIGTERM without stopping the inner one. Writes its own pid to `<dir>/wrapper-pid`.
//   default:         the inner process shares the launcher's output, so the output pipes stay open while it lives;
//   `--detach-inner`: the inner process has no output of its own and the launcher prints the lines, so the pipes close when the
//                    launcher leaves and only the inner process is left running.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[process.argv.indexOf("--dir") + 1];
const detach = process.argv.includes("--detach-inner");
writeFileSync(`${dir}/wrapper-pid`, String(process.pid));
const inner = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "slow-runtime.mjs"), "--dir", dir, "--stubborn"], { stdio: detach ? "ignore" : "inherit" });
process.on("SIGTERM", () => process.exit(0));
if (detach) {
  for (let i = 0; i < 150; i++) { process.stdout.write(`line ${i}\n`); await new Promise(resolve => setTimeout(resolve, 100)); }
} else inner.on("exit", code => process.exit(code ?? 1));
