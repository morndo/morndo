import type { SignInRuntime } from "@morndo/domain";

export type Recipe = {
  argv: (bins: { claude: string; cursor: string }) => readonly string[];
  link: RegExp;
  codePrompt: RegExp | null;
  extraEnv: (home: string, claudeConfigDir: string | null) => Record<string, string>;
};

const UNSET = [
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "CURSOR_API_KEY", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR",
] as const;

export function sessionCommand(
  home: string,
  bin: string,
  args: readonly string[],
  extra: Record<string, string>,
): readonly string[] {
  const out = ["env", ...UNSET.flatMap(u => ["-u", u]), `HOME=${home}`];
  for (const [k, v] of Object.entries(extra)) out.push(`${k}=${v}`);
  out.push(bin, ...args);
  return out;
}

export const RECIPES: Record<SignInRuntime, Recipe> = {
  claude: {
    argv: bins => [bins.claude, "auth", "login", "--claudeai"],
    link: /https:\/\/[^\s]+\/oauth\/authorize\?[^\s]*/,
    codePrompt: /Paste code here/i,
    extraEnv: (_home, claudeConfigDir) => (claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
  },
  cursor: {
    argv: bins => [bins.cursor, "login"],
    link: /https:\/\/(?:www\.)?cursor\.com\/loginDeepControl\?[^\s]*/,
    codePrompt: null,
    extraEnv: () => ({ NO_OPEN_BROWSER: "1" }),
  },
};
