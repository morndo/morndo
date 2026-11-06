// The install and update pages (README, SECURITY.md, the manual QA checklist) name only commands this tree
// accepts: install.sh's usage line, and `runUpdater`'s own parse (design §8.1, §8.3, §10.3, §14). A scratch
// HOME is a checkout, as cli.test.ts uses, so a parsed command ends in not_ours or a settings write, never in
// the usage exit, when the words are ones the program takes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runUpdater } from "../src/cli.ts";
import { wipe } from "./helpers/fakes.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const KEY_LINE = readFileSync(join(ROOT, "trust/release_allowed_signers"), "utf8").trim();

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

// Every Markdown page of the repository, from the root: the scan for a command or a note must not depend on a list.
const docFiles = (): string[] => {
  const skip = new Set(["node_modules", ".git", ".worktrees", ".keryx", "dist", "build", "coverage"]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(dir === "" ? entry.name : `${dir}/${entry.name}`);
      } else if (entry.name.endsWith(".md")) {
        out.push(dir === "" ? entry.name : `${dir}/${entry.name}`);
      }
    }
  };
  walk("");
  return out.sort();
};

// Each `gh attestation verify` in a text, read to the closing backtick or the end of its line, must carry
// `--signer-workflow`, and when a workflow follows it, that one (or a <placeholder> standing for it).
const attestationProblems = (text: string, signer: string): string[] => {
  const problems: string[] = [];
  for (const line of text.split("\n")) {
    for (const part of line.split("gh attestation verify").slice(1)) {
      const command = part.split("`")[0] ?? "";
      const flag = /--signer-workflow(?:[ =](\S+))?/.exec(command);
      if (flag === null) problems.push(`no --signer-workflow: ${line.trim()}`);
      else if (flag[1] !== undefined && !flag[1].startsWith("<") && flag[1] !== signer) problems.push(`another workflow: ${line.trim()}`);
    }
  }
  return problems;
};

// A copy of the gh version note: the minimum version, the Ubuntu package, or the advice not to drop the flag.
const holdsVersionNote = (text: string): boolean =>
  /`gh` 2\.51\.0 or newer|packages is 2\.45\.0|never drop `--signer-workflow`/.test(text);

// Fenced blocks. `lang` empty is every fence; "sh" is the shell blocks the command lists live in.
const fences = (text: string, lang = ""): string[] => {
  const re = lang === "" ? /```[^\n]*\n([\s\S]*?)```/g : new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  return [...text.matchAll(re)].map(m => m[1] ?? "");
};

// Placeholders the pages use, standing in for a real Version and a real window before the parser sees them.
const substitute = (line: string): string =>
  line.replaceAll("<version>", "0.2.0").replaceAll("<v>", "0.2.0").replaceAll("<HH:MM-HH:MM>", "03:30-05:00");

type Command = { line: string; argv: string[]; env: Record<string, string> };

// A line of a ```sh block that is a morndo command. An environment prefix (MORNDO_DISABLE_UPDATES=1) counts.
const commandOf = (raw: string): Command | null => {
  const line = substitute(raw).trim();
  if (line === "" || line.startsWith("#")) return null;
  const tokens = line.split(/\s+/);
  const env: Record<string, string> = {};
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    env[token.slice(0, eq)] = token.slice(eq + 1);
    i += 1;
  }
  if (tokens[i] !== "morndo") return null;
  const verb = tokens[i + 1];
  if (verb !== "update" && verb !== "doctor" && verb !== "install") return null;
  return { line, argv: tokens.slice(i + 1), env };
};

const commandsIn = (text: string): Command[] =>
  fences(text, "sh").flatMap(block => block.split("\n")).flatMap(line => {
    const command = commandOf(line);
    return command === null ? [] : [command];
  });

// install.sh lines inside ```sh blocks, continuation and all, so a flag on the continued line still counts.
const installLines = (text: string): string[] =>
  fences(text, "sh").flatMap(block => block.split("\n")).map(line => line.trim()).filter(line => /(^|\s)sh install\.sh(\s|$)/.test(line));

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

let homes = 0;
const run = async (argv: string[], env: Record<string, string> = {}): Promise<{ code: number; err: string }> => {
  const home = join(scratch, `home-${(homes += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const err: string[] = [];
  const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
    out() { /* the page test judges the exit, not the sentence */ },
    err: s => err.push(s),
  });
  return { code, err: err.join("") };
};

// The program's own usage text: what `update --bogus` prints. The accepted words live here.
const usageText = async (): Promise<string> => {
  const r = await run(["update", "--bogus"]);
  expect(r.code).toBe(64);
  return r.err;
};

const FORMS = ["morndo update", "--check", "--status", "--now", "--to", "--rollback", "--channel", "pin", "unpin", "auto", "window", "morndo doctor"];

describe("install and update documentation", () => {
  it("the README's key line is the committed release key, byte for byte", () => {
    const readme = read("README.md");
    const inFence = fences(readme).some(block => block.includes(KEY_LINE));
    expect(inFence).toBe(true);
    const verify = fences(readme, "sh").join("\n");
    expect(verify).toMatch(/ssh-keygen -Y verify\b[\s\S]*-I release@morndo\.github\.io\b/);
    expect(verify).toMatch(/ssh-keygen -Y verify\b[\s\S]*-n release@morndo\.github\.io\b/);
    expect(KEY_LINE).toContain("release@morndo.github.io");
  });

  it("SECURITY.md carries the same key line", () => {
    const readme = read("README.md");
    const security = read("SECURITY.md");
    expect(security).toContain(KEY_LINE);
    const readmeCopy = fences(readme).map(block => block.split("\n").find(line => line.includes(KEY_LINE))).find(line => line !== undefined);
    const securityCopy = security.split("\n").find(line => line.includes(KEY_LINE));
    expect(readmeCopy).toBeDefined();
    expect(securityCopy).toBeDefined();
    expect(readmeCopy!.includes(KEY_LINE) && securityCopy!.includes(KEY_LINE)).toBe(true);
    expect(KEY_LINE).toBe(securityCopy!.slice(securityCopy!.indexOf(KEY_LINE), securityCopy!.indexOf(KEY_LINE) + KEY_LINE.length));
    expect(readmeCopy!.slice(readmeCopy!.indexOf(KEY_LINE), readmeCopy!.indexOf(KEY_LINE) + KEY_LINE.length)).toBe(
      securityCopy!.slice(securityCopy!.indexOf(KEY_LINE), securityCopy!.indexOf(KEY_LINE) + KEY_LINE.length),
    );
  });

  it("the manual QA checklist saves the same key line as the README before it verifies", () => {
    const qa = read("docs/design/updates/manual-qa.md");
    const save = qa.indexOf(`> morndo.allowed_signers`);
    expect(save, "step 1 creates morndo.allowed_signers").toBeGreaterThan(0);
    expect(qa.slice(qa.lastIndexOf("\n", save), save)).toContain(KEY_LINE);
    expect(qa.indexOf("ssh-keygen -Y verify -f morndo.allowed_signers")).toBeGreaterThan(save);
  });

  it("the docs say what install.sh installs, what releases/latest is, and that the attestation is the independent check", () => {
    const readme = read("README.md");
    expect(readme).toContain("stamped into the copy you downloaded");
    expect(readme).toContain("does not choose the Version");
    expect(readme).toContain("releases/download/v<version>/");
    expect(readme).toMatch(/withdrawn Release is still there until a newer one is published/);
    expect(readme).not.toContain("installs the Channel's Version");
    expect(readme).toMatch(/independent check[^.]*not optional/);
    expect(read("SECURITY.md")).toMatch(/gh attestation verify install\.sh[\s\S]*?independent check[^.]*not optional/);
  });

  it("the gh version note is in the README alone, and every other page that shows the command links to it", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/needs `gh` 2\.51\.0 or newer/);
    expect(readme).toContain("releases/tag/v2.49.0");
    expect(readme).toContain("releases/tag/v2.51.0");
    expect(readme).toMatch(/never drop `--signer-workflow` to make the check pass/);
    expect(readme).toContain("#### The gh version the attestation check needs");
    const holders = docFiles().filter(file => holdsVersionNote(read(file)));
    expect(holders).toEqual(["README.md"]);
    for (const file of ["SECURITY.md", "docs/design/updates/manual-qa.md"]) {
      expect(read(file), file).toMatch(/\]\((\.\.\/)*README\.md#the-gh-version-the-attestation-check-needs\)/);
    }
  });

  it("holdsVersionNote sees a copy of the note, and not a link to it (negative control)", () => {
    expect(holdsVersionNote("It needs `gh` 2.51.0 or newer: the `attestation` command came in 2.49.0.")).toBe(true);
    expect(holdsVersionNote("The `gh` that Ubuntu 24.04 packages is 2.45.0 (seen 2026-10-28).")).toBe(true);
    expect(holdsVersionNote("On an older `gh`, upgrade it; never drop `--signer-workflow` to make the check pass.")).toBe(true);
    expect(holdsVersionNote("Which `gh` it needs is in [the README](README.md#the-gh-version-the-attestation-check-needs).")).toBe(false);
  });

  it("every gh attestation verify in any page of the repository pins the workflow the release job uses", () => {
    const release = read(".github/workflows/release.yml");
    const tail = /--signer-workflow "\$\{GITHUB_REPOSITORY\}(\/\.github\/workflows\/release\.yml@[^"]+)"/.exec(release)?.[1];
    expect(tail, "release.yml verifies with --signer-workflow").toBeDefined();
    const signer = `morndo/morndo${tail}`;
    const files = docFiles();
    for (const known of ["README.md", "SECURITY.md", "docs/design/updates/README.md", "docs/design/updates/manual-qa.md", "docs/plans/2026-10-28-c6-per-machine.md", "docs/adr/0019-releases-and-updates.md"]) {
      expect(files, "the scan reaches every page").toContain(known);
    }
    let seen = 0;
    for (const file of files) {
      const text = read(file);
      seen += text.split("gh attestation verify").length - 1;
      expect(attestationProblems(text, signer), file).toEqual([]);
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  it("attestationProblems fails a command without the pin, with another workflow, or with the flag cut off (negative control)", () => {
    const signer = "morndo/morndo/.github/workflows/release.yml@refs/heads/main";
    const ok = `gh attestation verify install.sh --repo morndo/morndo --signer-workflow ${signer}`;
    expect(attestationProblems("Run `" + ok + "` first.", signer)).toEqual([]);
    expect(attestationProblems("```sh\n" + ok + "\n```", signer)).toEqual([]);
    expect(attestationProblems("`gh attestation verify <file> --repo morndo/morndo --signer-workflow <release workflow>` [U7]", signer)).toEqual([]);
    expect(attestationProblems("Run `gh attestation verify install.sh --repo morndo/morndo` first.", signer)).toHaveLength(1);
    expect(attestationProblems("```sh\ngh attestation verify install.sh --repo morndo/morndo\n```", signer)).toHaveLength(1);
    expect(attestationProblems("with `ssh-keygen` and `gh attestation verify`.", signer)).toHaveLength(1);
    expect(attestationProblems("`gh attestation verify install.sh --signer-workflow other/repo/.github/workflows/x.yml@refs/heads/main`", signer)).toHaveLength(1);
    expect(attestationProblems("`gh attestation verify install.sh --repo morndo/morndo` and `--signer-workflow " + signer + "`", signer)).toHaveLength(1);
    expect(attestationProblems("a pinned one `" + ok + "` and a bare `gh attestation verify x`", signer)).toHaveLength(1);
  });

  it("the README's Status line does not call release verification unbuilt", () => {
    const status = read("README.md").split("\n").find(line => line.includes("Today the desktop")) ?? "";
    expect(status).toContain("Releases are verified before anything is installed");
    expect(status).toContain("verifying an agent's work");
  });

  it("the README's install flags are the ones install.sh accepts", () => {
    const ran = spawnSync("/bin/sh", [join(ROOT, "install.sh")], { encoding: "utf8" });
    expect(ran.status).toBe(64);
    const usage = ran.stderr ?? "";
    expect(usage).toMatch(/usage:/);
    const lines = installLines(read("README.md"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const flag of line.match(/--[A-Za-z0-9-]+/g) ?? []) expect(usage, line).toContain(flag);
      const role = /--role\s+(\S+)/.exec(line);
      if (role !== null) expect(usage, line).toContain(role[1]);
      const channel = /--channel\s+(\S+)/.exec(line);
      if (channel !== null) expect(usage, line).toContain(channel[1]);
    }
  });

  it("every morndo command in the README is a form the updater parses", async () => {
    const readme = read("README.md");
    const accepted = await usageText();
    const shown = new Set(commandsIn(readme).flatMap(c => c.argv));
    for (const form of FORMS) {
      for (const word of form.split(" ")) {
        if (word !== "morndo") expect(shown, `no sh block shows "${form}"`).toContain(word);
      }
    }
    for (const word of ["--check", "--status", "--now", "--to", "--rollback", "--channel", "pin", "unpin", "auto", "window", "doctor"]) {
      expect(accepted, word).toContain(word);
    }
    const commands = commandsIn(readme);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const r = await run(command.argv, command.env);
      expect(r.code, `${command.line}\n${r.err}`).not.toBe(64);
      for (const token of command.argv) if (token.startsWith("--")) expect(accepted, command.line).toContain(token);
    }
  });

  it("every morndo command in the manual QA checklist is a form the updater parses", async () => {
    const checklist = read("docs/design/updates/manual-qa.md");
    const numbers = [...checklist.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const accepted = await usageText();
    const commands = commandsIn(checklist);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const r = await run(command.argv, command.env);
      expect(r.code, `${command.line}\n${r.err}`).not.toBe(64);
      for (const token of command.argv) if (token.startsWith("--")) expect(accepted, command.line).toContain(token);
    }
  });

  it("the README does not document what the updater does not do", () => {
    expect(read("README.md")).not.toContain("--allow-downgrade");
  });
});
