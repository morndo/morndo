// A bin the way the CLIs end: quiet on a closed pipe, output written, then out with its code. Run by exit-after-output.test.ts.
//   lingering: a child keeps its stdout pipe open through a grandchild in its own session (as a tool started by a bin can),
//              so this process has a live handle for 15 s; the bin must still leave once its output is out.
//   big:       writes more than a pipe takes at once.
//   eio, enospc: a write error of that kind is reported on stdout, as a gone terminal (EIO) or a full disk (ENOSPC) does.
import { spawn } from "node:child_process";
import { exitAfterOutput, quietBrokenPipe } from "../src/index.ts";

quietBrokenPipe();
const mode = process.argv[2];
if (mode === "lingering") {
  const child = spawn("sh", ["-c", "setsid sleep 15 & echo $!"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(`grandchild ${chunk.toString().trim()}\n`));
  await new Promise<void>(resolve => child.stdout.once("data", () => resolve()));
  process.stdout.write("output\n");
  await exitAfterOutput(7);
} else if (mode === "eio" || mode === "enospc") {
  const code = mode === "eio" ? "EIO" : "ENOSPC";
  process.stdout.emit("error", Object.assign(new Error(`write ${code}`), { code }));
  process.stdout.write("after\n");
  await exitAfterOutput(5);
} else {
  process.stdout.write(`${"x".repeat(4 * 1024 * 1024)}\n`);
  await exitAfterOutput(3);
}
