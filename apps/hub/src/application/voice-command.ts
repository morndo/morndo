// A voice note that does not fit pane.send goes out as a markdown upload (design §10). The command itself stays
// inside LIMITS.maxSendText. The words are the file; the command only names the files.
import { LIMITS } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";

export function voiceCommand(
  text: string, audioPath: string, voiceId: string, save: (name: string, body: string) => string,
): { command: string; markdownPath: string | null } {
  const audio = ownerFileNote(audioPath);
  const inline = `${text}\n${audio}`;
  if (inline.length <= LIMITS.maxSendText) return { command: inline, markdownPath: null };
  const path = save(`voice-${voiceId}.md`, text);
  return { command: `${ownerFileNote(path)}\n${audio}`, markdownPath: path };
}
