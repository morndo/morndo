// API-key shapes in the shared redactor (ADR-0018 §6.2). Every value is synthetic: made up, never a real key.
import { describe, expect, it } from "vitest";
import { redactKeyMaterial, redactText } from "../src/redact.ts";

const ANTHROPIC = `sk-ant-api03-${"a".repeat(24)}`;
const OPENAI = `sk-proj-${"b".repeat(24)}`;
const DEEPSEEK = `sk-${"0123456789abcdef".repeat(2)}`;
const OPENROUTER = `sk-or-v1-${"e".repeat(64)}`;
const AGE = `AGE-SECRET-KEY-1${"Q".repeat(16)}`;

describe("API-key shapes", () => {
  it("blanks Anthropic, OpenAI, DeepSeek and OpenRouter keys, and an age identity", () => {
    const line = `anthropic ${ANTHROPIC} openai ${OPENAI} deepseek ${DEEPSEEK} openrouter ${OPENROUTER} age ${AGE}`;
    const out = redactKeyMaterial(line);
    for (const key of [ANTHROPIC, OPENAI, DEEPSEEK, OPENROUTER, AGE]) expect(out, key).not.toContain(key);
    expect(out).toBe("anthropic [redacted] openai [redacted] deepseek [redacted] openrouter [redacted] age [redacted]");
  });
  it("blanks _TOKEN= and _KEY= assignments and keeps the name", () => {
    expect(redactKeyMaterial(`export ANTHROPIC_API_KEY=${ANTHROPIC}`)).toBe("export ANTHROPIC_API_KEY=[redacted]");
    expect(redactKeyMaterial(`DEEPSEEK_API_KEY="plain-secret-value"`)).toBe("DEEPSEEK_API_KEY=[redacted]");
    expect(redactKeyMaterial("OPENAI_API_KEY='sk-proj-not-long'")).toBe("OPENAI_API_KEY=[redacted]");
  });
  it("the log redactor blanks a key and still blanks an email", () => {
    const out = redactText(`mail someone@example.test key ${ANTHROPIC}`, "/home/someone");
    expect(out).not.toContain(ANTHROPIC);
    expect(out).toBe("mail [email] key [redacted]");
  });
  it("blanks the same key on a later string", () => {
    expect(redactKeyMaterial(ANTHROPIC)).toBe("[redacted]");
    expect(redactKeyMaterial(`again ${ANTHROPIC}`)).toBe("again [redacted]");
  });
  it("blanks a key whose tail was wrapped onto the next line", () => {
    const tail = "defghijklmnopqrstuvwxyz0123456789";
    const wrapped = `key: sk-ant-abc\n  ${tail}`;
    const out = redactKeyMaterial(wrapped);
    expect(out).not.toContain(tail);
    expect(out).toBe("key: [redacted]");
    const prose = "sketch the plan\n  then stop";
    expect(redactKeyMaterial(prose)).toBe(prose);
  });
  it("joins only an unfinished key at the end of the line, and leaves every other character", () => {
    expect(redactKeyMaterial("- run the task-board\n  then deploy")).toBe("- run the task-board\n  then deploy");
    expect(redactKeyMaterial("key sk-ant-abcdefghijk done\n  Next step")).toBe("key [redacted] done\n  Next step");
    expect(redactKeyMaterial("sk-ant-abcdefghijk\n  Next step")).toBe("[redacted]\n  Next step");
    expect(redactKeyMaterial("ask-for help\n  then stop")).toBe("ask-for help\n  then stop");
  });
  it("blanks yaml, spaced and json assignments, secrets, and vendor tokens", () => {
    const ghp = `ghp_${"a".repeat(36)}`;
    const pat = `github_pat_${"b".repeat(22)}_${"c".repeat(59)}`;
    const aiza = `AIza${"a".repeat(35)}`;
    expect(redactKeyMaterial("ANTHROPIC_API_KEY: plainvalue")).toBe("ANTHROPIC_API_KEY=[redacted]");
    expect(redactKeyMaterial("OPENAI_API_KEY = 'abcdef'")).toBe("OPENAI_API_KEY=[redacted]");
    expect(redactKeyMaterial('{"ANTHROPIC_API_KEY":"notprefixed"}')).toBe('{"ANTHROPIC_API_KEY":"[redacted]"}');
    expect(redactKeyMaterial('{"ANTHROPIC_API_KEY":"sk"}')).toBe('{"ANTHROPIC_API_KEY":"[redacted]"}');
    expect(redactKeyMaterial("MY_SECRET=hunter2")).toBe("MY_SECRET=[redacted]");
    expect(redactKeyMaterial("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=[redacted]");
    expect(redactKeyMaterial(`token ${ghp} ${pat} ${aiza}`)).toBe("token [redacted] [redacted] [redacted]");
    expect(redactKeyMaterial(`AIza${"a".repeat(34)}`)).toBe(`AIza${"a".repeat(34)}`);
  });
  it("keeps ordinary code and the punctuation after an uppercase assignment", () => {
    for (const line of ["models.AutoField(primary_key=True)", "sorted(xs, sort_key=len)", "?page_token=abc&limit=10"]) {
      expect(redactKeyMaterial(line), line).toBe(line);
    }
    expect(redactKeyMaterial("export FOO_KEY=abc)")).toBe("export FOO_KEY=[redacted]");
    expect(redactKeyMaterial("FOO_TOKEN=abc&limit=10")).toBe("FOO_TOKEN=[redacted]");
    expect(redactKeyMaterial("DB_PASSWORD=abc;defsecret")).toBe("DB_PASSWORD=[redacted]");
    expect(redactKeyMaterial("API_TOKEN=abc&xyz123")).toBe("API_TOKEN=[redacted]");
    expect(redactKeyMaterial("export api_token=supersecretvalue")).toBe("export api_token=[redacted]");
  });
  it("leaves short lookalikes and ordinary words (negative control)", () => {
    const line = "sketch the plan, sk-abc, sk-ant-short, count=3, APIKEY=value";
    expect(redactKeyMaterial(line)).toBe(line);
    expect(redactKeyMaterial(`sk-${"a".repeat(19)}`)).toBe(`sk-${"a".repeat(19)}`);
    expect(redactKeyMaterial(`sk-${"a".repeat(20)}`)).toBe("[redacted]");
    expect(redactKeyMaterial(`sk-ant-${"a".repeat(7)}`)).toBe(`sk-ant-${"a".repeat(7)}`);
    expect(redactKeyMaterial(`sk-ant-${"a".repeat(8)}`)).toBe("[redacted]");
  });
});
