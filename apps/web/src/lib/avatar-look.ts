import type { AuthorKind } from "@morndo/domain";

export const MARK_PATH = "M0 0L48 0L48 48L0 48ZM8 26A16 16 0 0 1 40 26A16 16 0 0 1 8 26ZM0 27L48 27L48 33L0 33Z";

export type AvatarLook = "manager" | "principal" | "agent" | "peer" | "system";

// Who an avatar shows (chat-authors): the manager wears the Morndo mark wherever it appears — however a view names or
// files it, as every view files it kind "peer" or "agent" with the name "Manager" or "manager" (Desktop's nameOf treats
// a lane named "manager" as it). Everyone else keeps a look of their own, so the owner's own messages never look like its.
export function avatarLook(name: string, kind: AuthorKind): AvatarLook {
  if ((kind === "peer" || kind === "agent") && name.trim().toLowerCase() === "manager") return "manager";
  return kind;
}
