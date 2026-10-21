// Stands in for a runtime binary that streams a long turn: a line every 100 ms for 15 s, then a marker file. `--dir <path>`
// (given after `--` on the command line) is where it writes its pid, at the start, and `finished`, if the turn ran to the end.
// `--stubborn`: it ignores SIGTERM. `--fast`: three lines 10 ms apart, then `finished` and a clean exit.
import { writeFileSync } from "node:fs";

const dir = process.argv[process.argv.indexOf("--dir") + 1];
if (process.argv.includes("--stubborn")) process.on("SIGTERM", () => {});
writeFileSync(`${dir}/pid`, String(process.pid));
const fast = process.argv.includes("--fast");
for (let i = 0; i < (fast ? 3 : 150); i++) {
  process.stdout.write(`line ${i}\n`);
  await new Promise(resolve => setTimeout(resolve, fast ? 10 : 100));
}
writeFileSync(`${dir}/finished`, "yes");
