// A worker's terminal, /api/terminal (ADR-0006, AC9): every JSON frame type in both directions.
import * as z from "./z.ts";

const int = () => z.int().check(z.gte(0));

// Hub → app.
export const ServerTerminalFrames = {
  mode: z.object({ t: z.literal("mode"), control: z.boolean() }),
  frame: z.object({
    t: z.literal("frame"), cols: int(), rows: int(), x: int(), y: int(), cursor: z.boolean(),
    lines: z.array(z.string()),
  }),
  error: z.object({ t: z.literal("error"), error: z.string() }),
};

// App → hub. The socket's own size limit (1 MiB) bounds the keys.
export const ClientTerminalFrames = {
  keys: z.object({ t: z.literal("keys"), data: z.string() }),
};

export type ServerTerminalFrame = { [K in keyof typeof ServerTerminalFrames]: z.output<(typeof ServerTerminalFrames)[K]> }[keyof typeof ServerTerminalFrames];
