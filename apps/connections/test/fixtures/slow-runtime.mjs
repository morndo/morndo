// Stands in for a runtime binary that streams a long turn: a line every 100 ms for 15 s, then a marker file. `--dir <path>`
// (given after `--` on the command line) is where it writes its pid, at the start, and `finished`, if the turn ran to the end.
// `--stubborn`: it ignores SIGTERM.
import { writeFileSync } from "node:fs";

const dir = process.argv[process.argv.indexOf("--dir") + 1];
if (process.argv.includes("--stubborn")) process.on("SIGTERM", () => {});
writeFileSync(`${dir}/pid`, String(process.pid));
for (let i = 0; i < 150; i++) {
  process.stdout.write(`line ${i}\n`);
  await new Promise(resolve => setTimeout(resolve, 100));
}
writeFileSync(`${dir}/finished`, "yes");
