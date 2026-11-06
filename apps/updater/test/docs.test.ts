// The install and update pages (README, SECURITY.md, the manual QA checklist) name only commands this tree
// accepts: install.sh's usage line, and `runUpdater`'s own parse (design §8.1, §8.3, §10.3, §14). A scratch
// HOME is a checkout, as cli.test.ts uses, so a parsed command ends in not_ours or a settings write, never in
// the usage exit, when the words are ones the program takes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runUpdater } from "../src/cli.ts";
import { wipe } from "./helpers/fakes.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const KEY_LINE = readFileSync(join(ROOT, "trust/release_allowed_signers"), "utf8").trim();

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

// The Markdown pages git tracks, read once. CHANGELOG.md is written by Release Please from commit subjects, not by hand.
let pagesOnce: Record<string, string> | null = null;
const pages = (): Record<string, string> => {
  if (pagesOnce !== null) return pagesOnce;
  const listed = spawnSync("git", ["ls-files", "-z", "*.md"], { cwd: ROOT, encoding: "utf8" });
  expect(listed.status, "git ls-files").toBe(0);
  const out: Record<string, string> = {};
  for (const file of listed.stdout.split("\0").filter(f => f !== "" && posix.basename(f) !== "CHANGELOG.md")) out[file] = read(file);
  pagesOnce = out;
  return out;
};

const NOTE_HEADING = "the-gh-version-the-attestation-check-needs";

// The commands a page shows: a fenced line or an inline code span that starts with `gh attestation verify` and names
// a file after it (a wrapped line is joined). A span that is only the name, or the name and a flag, is prose.
const attestationCommands = (text: string): string[] => {
  const out: string[] = [];
  const keep = (raw: string): void => {
    const command = raw.replace(/\s+/g, " ").replace(/^\$ /, "").trim();
    const subject = /^gh attestation verify (\S+)/.exec(command)?.[1];
    if (subject !== undefined && !subject.startsWith("-")) out.push(command);
  };
  for (const block of fences(text)) for (const line of block.replace(/\\\n\s*/g, " ").split("\n")) keep(line);
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  for (const span of prose.matchAll(/`([^`]+)`/g)) keep(span[1] ?? "");
  return out;
};

// A command must pin the whole workflow the release job signs with, as the value of --signer-workflow.
const pinProblems = (text: string, signer: string): string[] =>
  attestationCommands(text).flatMap(command => {
    const value = /--signer-workflow(?:\s+|=)(\S+)/.exec(command)?.[1]?.replace(/^["']|["';]+$/g, "");
    return value === signer ? [] : [`${value === undefined ? "no pin" : "another workflow"}: ${command}`];
  });

// The note on which gh to use: the minimum version, the Ubuntu package, or the advice not to drop the flag.
const holdsVersionNote = (text: string): boolean =>
  /`gh` 2\.51\.0 or newer|packages is 2\.45\.0|never drop `--signer-workflow`/.test(text);

// Does the page link to the README's note on the gh version (a relative link that lands on the repository README)?
const linksToVersionNote = (file: string, text: string): boolean =>
  [...text.matchAll(/\]\(([^)#\s]*)#([^)\s]+)\)/g)].some(
    m => m[2] === NOTE_HEADING && posix.normalize(posix.join(posix.dirname(file), m[1] ?? "")) === "README.md");

// Everything the pages must satisfy about the attestation command. Empty is a pass.
const attestationRules = (docs: Record<string, string>, signer: string): string[] => {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(docs)) {
    const shows = attestationCommands(text).length > 0;
    problems.push(...pinProblems(text, signer).map(p => `${file}: ${p}`));
    if (file === "README.md") {
      if (!holdsVersionNote(text)) problems.push("README.md: has no note on the gh version");
    } else {
      if (holdsVersionNote(text)) problems.push(`${file}: copies the gh version note`);
      if (shows && !linksToVersionNote(file, text)) problems.push(`${file}: shows the command and does not link to the README's note`);
    }
  }
  return problems;
};

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

  const releaseSigner = (): string => {
    const tail = /--signer-workflow "\$\{GITHUB_REPOSITORY\}(\/\.github\/workflows\/release\.yml@[^"]+)"/.exec(read(".github/workflows/release.yml"))?.[1];
    expect(tail, "release.yml verifies with --signer-workflow").toBeDefined();
    return `morndo/morndo${tail}`;
  };

  it("the README holds the gh version note, under a heading the other pages link to", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/needs `gh` 2\.51\.0 or newer/);
    expect(readme).toContain("releases/tag/v2.49.0");
    expect(readme).toContain("releases/tag/v2.51.0");
    expect(readme).toMatch(/never drop `--signer-workflow` to make the check pass/);
    expect(readme).toContain("#### The gh version the attestation check needs");
  });

  it("every tracked page that shows gh attestation verify pins the release workflow, and only the README holds the version note", () => {
    const docs = pages();
    expect(Object.keys(docs)).toEqual(expect.arrayContaining(["README.md", "SECURITY.md", "docs/design/updates/README.md", "docs/design/updates/manual-qa.md", "docs/plans/2026-10-28-c6-per-machine.md"]));
    expect(Object.keys(docs)).not.toContain("CHANGELOG.md");
    const showing = Object.entries(docs).filter(([, text]) => attestationCommands(text).length > 0).map(([file]) => file);
    expect(showing).toEqual(expect.arrayContaining(["README.md", "SECURITY.md", "docs/design/updates/README.md", "docs/design/updates/manual-qa.md", "docs/plans/2026-10-28-c6-per-machine.md"]));
    expect(attestationRules(docs, releaseSigner())).toEqual([]);
  });

  it("the rules fail a page that breaks them, and pass the same page when it does not (negative control)", () => {
    const signer = releaseSigner();
    const ok = `gh attestation verify install.sh --repo morndo/morndo --signer-workflow ${signer}`;
    const link = `[the README](README.md#${NOTE_HEADING})`;
    const base = { "README.md": "It needs `gh` 2.51.0 or newer. Run `" + ok + "`.", "A.md": "Run `" + ok + "`. " + link };
    expect(attestationRules(base, signer)).toEqual([]);
    const without = (command: string): string[] => attestationRules({ ...base, "A.md": "Run `" + command + "`. " + link }, signer);
    expect(without("gh attestation verify install.sh --repo morndo/morndo")).toHaveLength(1);
    expect(without("gh attestation verify install.sh --repo morndo/morndo --signer-workflow")).toHaveLength(1);
    expect(without("gh attestation verify install.sh --signer-workflow <release workflow>")).toHaveLength(1);
    expect(without("gh attestation verify install.sh --signer-workflow other/repo/.github/workflows/x.yml@refs/heads/main")).toHaveLength(1);
    expect(without(ok + "  ")).toEqual([]);
    expect(attestationRules({ ...base, "A.md": "```sh\n" + ok.replace(" --signer-workflow", " \\\n  --signer-workflow") + "\n```\n" + link }, signer)).toEqual([]);
    expect(attestationRules({ ...base, "A.md": "```sh\n" + ok + ";\n```\n" + link }, signer)).toEqual([]);
    expect(attestationRules({ ...base, "A.md": "```sh\ngh attestation verify install.sh --repo morndo/morndo\n```\n" + link }, signer)).toHaveLength(1);
    expect(attestationRules({ ...base, "A.md": "Run `" + ok + "` and, without the pin, `gh attestation verify x`. " + link }, signer)).toHaveLength(1);
    // Prose that names the command or the flag is not a command.
    expect(attestationRules({ ...base, "B.md": "Checked with `ssh-keygen` and `gh attestation verify`, and `gh attestation verify --signer-workflow` pins it." }, signer)).toEqual([]);
    // A page that shows the command needs the link; a copy of the note belongs to the README only.
    expect(attestationRules({ ...base, "A.md": "Run `" + ok + "`." }, signer)).toHaveLength(1);
    expect(attestationRules({ ...base, "A.md": "Run `" + ok + "`. " + link, "C.md": "It needs `gh` 2.51.0 or newer." }, signer)).toHaveLength(1);
    expect(attestationRules({ ...base, "docs/D.md": "Run `" + ok + "`. [x](README.md#" + NOTE_HEADING + ")" }, signer)).toHaveLength(1);   // that resolves to docs/README.md
    expect(attestationRules({ ...base, "docs/D.md": "Run `" + ok + "`. [x](../README.md#" + NOTE_HEADING + ")" }, signer)).toEqual([]);
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
