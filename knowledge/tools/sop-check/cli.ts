// sop-check's command line (stub until the next commit).
export const DEFAULT_ROLES: readonly string[] = [];
export type Io = { skillDir: string; out: (line: string) => void; err: (line: string) => void };
export async function run(_args: readonly string[], _io: Io): Promise<number> {
  return -1;
}
