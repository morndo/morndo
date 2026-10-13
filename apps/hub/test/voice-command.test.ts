// A voice note that does not fit the send cap goes out as a markdown upload (design §10, §13).
import { describe, expect, it } from "vitest";
import { LIMITS, OP_ARGS } from "@morndo/protocol";
import { ownerFileNote } from "../src/adapters/attachment-note.ts";
import { voiceCommand } from "../src/application/voice-command.ts";

const send = (text: string) => OP_ARGS["pane.send"].safeParse({
  workerId: "pc.3fa2c1d0.1", text, expect: { server: "3fa2c1d0", window: "builder" },
});

describe("voice command", () => {
  it("keeps a short note in the command, and a long one as a markdown file the send schema accepts", () => {
    const audio = "/inbox/pasted-note.ogg";
    const saved: { name: string; body: string }[] = [];
    const save = (name: string, body: string) => { saved.push({ name, body }); return `/inbox/${name}`; };
    const short = voiceCommand("Kurze Notiz.", audio, "v1", save);
    expect(saved).toEqual([]);
    expect(short).toEqual({ command: `Kurze Notiz.\n${ownerFileNote(audio)}`, markdownPath: null });
    expect(send(short.command).success).toBe(true);

    const text = "y".repeat(LIMITS.maxSendText);
    const long = voiceCommand(text, audio, "v1", save);
    expect(saved).toEqual([{ name: "voice-v1.md", body: text }]);
    expect(long.markdownPath).toBe("/inbox/voice-v1.md");
    expect(long.command).toBe(`${ownerFileNote("/inbox/voice-v1.md")}\n${ownerFileNote(audio)}`);
    expect(long.command.length).toBeLessThanOrEqual(LIMITS.maxSendText);
    expect(send(long.command).success).toBe(true);
    expect(send(`${text}\n${ownerFileNote(audio)}`).success).toBe(false);
  });
});
