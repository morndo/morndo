// The note the box's chat bot (kira) types for a file the principal attached: "[The owner attached a file: <path>]".
// The manager's instructions name it, and any worker reads the path from it and opens the file (Claude Code takes an
// image by its path: https://code.claude.com/docs/en/common-workflows#work-with-images). The hub writes the same note
// for images pasted in the app, and the transcript adapter reads it back, so both sides use this one definition.
export const ownerFileNote = (path: string) => `[The owner attached a file: ${path}]`;
export const OWNER_FILE = /\[The owner attached a file: (\/[^\]\n]+)\]/g;
