// A launcher around the real work, as some CLIs are: it starts slow-runtime.mjs (which ignores SIGTERM) as an inner process that
// shares its output, and leaves at once on SIGTERM without stopping the inner one. Writes its own pid to `<dir>/wrapper-pid`.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[process.argv.indexOf("--dir") + 1];
writeFileSync(`${dir}/wrapper-pid`, String(process.pid));
const inner = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "slow-runtime.mjs"), "--dir", dir, "--stubborn"], { stdio: "inherit" });
process.on("SIGTERM", () => process.exit(0));
inner.on("exit", code => process.exit(code ?? 1));
