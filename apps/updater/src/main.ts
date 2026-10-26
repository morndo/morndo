#!/usr/bin/env node
// morndo-update: the updater's program (design §4.7, §8.1). The hub runs it with an argument list and no shell
// (§4.8), a service unit runs it at boot and every six hours, and a principal runs it by hand; everything it decides
// comes back as its exit code (§8.4). The end of the run waits for its own output, as a bin's does
// (service-kit exit-after-output.ts).
import { exitAfterOutput, quietBrokenPipe } from "@morndo/service-kit";
import { runUpdater } from "./cli.ts";

quietBrokenPipe();
process.exitCode = await runUpdater(process.argv.slice(2), process.env, {
  out: text => { process.stdout.write(text); },
  err: text => { process.stderr.write(text); },
});
await exitAfterOutput(process.exitCode);
