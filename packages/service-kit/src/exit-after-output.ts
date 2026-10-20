// How a CLI bin ends. process.exit() right after a write cuts what a pipe has not taken yet (Node writes to a pipe
// asynchronously on POSIX), and a bare exit code waits for every live handle, such as a pipe a grandchild keeps open.
// So a bin writes, waits for the write callbacks of stdout and stderr (writes to a stream finish in order, so an empty
// write finishes last), then exits with its code. A reader that closes the pipe early makes a write fail with EPIPE:
// that ends the output, not the bin (https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io and
// https://nodejs.org/docs/latest-v24.x/api/stream.html#writablewritechunk-encoding-callback, read 2026-10-20).

// Call first thing in a bin: a broken pipe on stdout or stderr is dropped; any other stream error is still thrown.
export function quietBrokenPipe(streams: readonly NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
  }
}

const written = (stream: NodeJS.WriteStream) => new Promise<void>(resolve => { stream.write("", () => resolve()); });

export async function exitAfterOutput(code: number): Promise<never> {
  await Promise.all([written(process.stdout), written(process.stderr)]);
  process.exit(code);
}
