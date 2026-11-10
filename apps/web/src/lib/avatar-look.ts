import type { AuthorKind } from "@morndo/domain";

export const MARK_PATH = "M0 0L48 0L48 48L0 48ZM8 26A16 16 0 0 1 40 26A16 16 0 0 1 8 26ZM0 27L48 27L48 33L0 33Z";

export type AvatarLook = "manager" | "principal" | "agent" | "peer" | "system";

export function avatarLook(name: string, kind: AuthorKind): AvatarLook {
  return kind;
}
