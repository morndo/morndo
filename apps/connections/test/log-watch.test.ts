// The log matcher of `keypool watch` (ADR-0037, slice 4; plan 3.6): a server's log holds anyone's words, so only the classifier's two exhausted phrases act (the
// credit balance and the specified usage limits). A verdict holds no part of the line. A line is cut at 8 KB, a partial line waits for its newline, and
// what the command prints passes the exact-value filter.
import { describe, expect, it } from "vitest";
import { lineScanner, lineVerdict, redactingWriter } from "../src/adapters/log-watch.ts";

const CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const CODE_LINE = "Credit balance is too low";
const SPEND = "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
const WORKSPACE_SPEND = "You have reached your specified workspace API usage limits.";

describe("lineVerdict", () => {
  it("a credit line and a spend-limit line are verdicts, in either wording, inside any other text", () => {
    expect(lineVerdict(CREDIT)).toBe("exhausted-credit");
    expect(lineVerdict(CODE_LINE)).toBe("exhausted-credit");
    expect(lineVerdict(`2026-10-26T10:00:00Z ERROR upstream said: ${CREDIT} (request failed)`)).toBe("exhausted-credit");
    expect(lineVerdict(SPEND)).toBe("exhausted-spend");
    expect(lineVerdict(WORKSPACE_SPEND)).toBe("exhausted-spend");
    expect(lineVerdict(`{"level":"error","msg":"${SPEND}"}`)).toBe("exhausted-spend");
  });
  it("an ordinary line, a rate-limit line, a hold line and a line that only mentions credit are none", () => {
    for (const line of [
      "", "GET /health 200", "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
      "403 permission_error: account_on_hold", "authentication_failed for user bob", "please do not include your credit card number",
      "401 invalid x-api-key", "529 overloaded_error",
    ]) expect(lineVerdict(line), line).toBe("none");
  });
  it("the verdict is a word: it holds no part of the line", () => {
    const planted = "planted-secret-in-the-log-line";
    expect(lineVerdict(`${CREDIT} ${planted}`)).toBe("exhausted-credit");
    expect(JSON.stringify([lineVerdict(`${CREDIT} ${planted}`)])).not.toContain(planted);
  });
});

describe("lineScanner", () => {
  it("returns the verdicts of the complete lines, in order, and no verdict for the rest", () => {
    const scan = lineScanner();
    expect(scan.push(`ok\n${CREDIT}\n${SPEND}\nstill ok\n`)).toEqual(["exhausted-credit", "exhausted-spend"]);
    expect(scan.push("")).toEqual([]);
  });
  it("a line split across two reads is joined; a partial last line waits for its newline", () => {
    const scan = lineScanner();
    expect(scan.push(CREDIT.slice(0, 20))).toEqual([]);
    expect(scan.push(CREDIT.slice(20))).toEqual([]);
    expect(scan.push("\n")).toEqual(["exhausted-credit"]);
    expect(scan.push(`${CODE_LINE}`)).toEqual([]);
    expect(scan.push(" more\nnext\n")).toEqual(["exhausted-credit"]);
  });
  it("a phrase split exactly at a read boundary is still found", () => {
    const scan = lineScanner();
    const line = `error: ${CODE_LINE}\n`;
    for (let cut = 1; cut < line.length; cut++) {
      const fresh = lineScanner();
      expect([...fresh.push(line.slice(0, cut)), ...fresh.push(line.slice(cut))], `cut at ${cut}`).toEqual(["exhausted-credit"]);
    }
    expect(scan.push("")).toEqual([]);
  });
  it("a very long line is cut at 8 KB, not buffered whole: a phrase after the cut is not seen, the next line is", () => {
    const scan = lineScanner();
    const long = `${"x".repeat(9000)} ${CREDIT}`;
    expect(scan.push(`${long}\n${CREDIT}\n`)).toEqual(["exhausted-credit"]);
    const huge = lineScanner();
    for (let i = 0; i < 50; i++) huge.push("y".repeat(100_000));
    expect(huge.buffered()).toBeLessThanOrEqual(8192);
    expect(huge.push(`\n${CODE_LINE}\n`)).toEqual(["exhausted-credit"]);
  });
  it("a phrase inside the first 8 KB of a long line is found", () => {
    const scan = lineScanner();
    expect(scan.push(`${CREDIT} ${"z".repeat(20_000)}\n`)).toEqual(["exhausted-credit"]);
  });
});

describe("redactingWriter", () => {
  it("replaces a key in what is written, whole or split over two writes of the same line, and passes the rest", () => {
    const out: string[] = [];
    const secret = "sk-ant-synthetic-watch-key-0001";
    const write = redactingWriter(text => { out.push(text); }, [secret]);
    write(`leaked ${secret} here\n`);
    write(`and ${secret.slice(0, 10)}`);
    write(`${secret.slice(10)} again\n`);
    write("plain\n");
    expect(out.join("")).not.toContain(secret);
    expect(out.join("")).toContain("[redacted]");
    expect(out.join("")).toContain("plain\n");
  });
  it("with no secret it writes the text unchanged", () => {
    const out: string[] = [];
    redactingWriter(text => { out.push(text); }, [])("hello\n");
    expect(out.join("")).toBe("hello\n");
  });
});
