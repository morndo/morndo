// The hub's logger (ADR-0008, A4; design reference: Signal-Desktop ts/util/privacy.node.ts and ts/types/errors.std.ts):
// levels, and one sink that redacts every line, error stacks included. All values below are synthetic.
import { describe, expect, it } from "vitest";
import { createLogger, redact, toLogFormat, type Level } from "../src/adapters/log.ts";

const HOME = "/home/someone";
const r = (s: string) => redact(s, HOME);

describe("redact", () => {
  it("emails, and logins that aren't email-shaped (review L3)", () => {
    expect(r("login principal.name+x@example.test refused")).toBe("login [email] refused");
    expect(r("login someone@github refused")).toBe("login [email] refused");
    expect(r("login someone@passkey")).toBe("login [email]");
  });
  it("tailnet host names (*.ts.net)", () => {
    expect(r("origin https://office-box.tail1234.ts.net:8443/api")).toBe("origin https://[tailnet-host]:8443/api");
    expect(r("BOX.TAILABCD.TS.NET")).toBe("[tailnet-host]");
    expect(r("example.net and ts.network.example")).toBe("example.net and ts.network.example");    // not tailnet names
  });
  it("tailnet addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48", () => {
    expect(r("from 100.64.0.1 and 100.127.255.254")).toBe("from [tailnet-ip] and [tailnet-ip]");
    expect(r("peer fd7a:115c:a1e0:ab12::1 up")).toBe("peer [tailnet-ip] up");
    // Just outside the range, and lookalikes, stay.
    expect(r("100.63.255.255 100.128.0.1 10.100.64.1 1100.64.0.1")).toBe("100.63.255.255 100.128.0.1 10.100.64.1 1100.64.0.1");
  });
  it("the session cookie's value, wherever it appears", () => {
    expect(r("cookie: __Host-morndo=AbC_dEf-123; other=1")).toBe("cookie: __Host-morndo=[redacted]; other=1");
    expect(r("Set-Cookie: __Host-morndo=xyz; Path=/")).toBe("Set-Cookie: __Host-morndo=[redacted]; Path=/");
  });
  it("bearer tokens", () => {
    expect(r("authorization: Bearer eyJhbGciOi.payload.sig")).toBe("authorization: Bearer [redacted]");
  });
  it("pairing secrets in a URL: t= and #t=", () => {
    expect(r("open https://hub.example/pair#t=s3cretS3cret&f=ab12")).toBe("open https://hub.example/pair#t=[redacted]&f=ab12");
    expect(r("GET /pair?t=abc123 then /x?a=1&t=def")).toBe("GET /pair?t=[redacted] then /x?a=1&t=[redacted]");
    expect(r("format=json count=3")).toBe("format=json count=3");                                    // other "t=" words stay
    expect(r("next=%2Fpair%23t%3Ds3cret%26f%3Dab12")).toBe("next=%2Fpair%23t%3D[redacted]%26f%3Dab12");  // URL-encoded (review L3)
  });
  it("secrets in JSON bodies by name", () => {
    expect(r('{"secret":"abc","cookieSecret":"def","token":"ghi","name":"phone"}'))
      .toBe('{"secret":"[redacted]","cookieSecret":"[redacted]","token":"[redacted]","name":"phone"}');
  });
  it("a synthetic API key in a log line", () => {
    const key = `sk-ant-api03-${"a".repeat(24)}`;
    const lines: string[] = [];
    const logger = createLogger({ sink: line => lines.push(line), home: HOME });
    logger.info(`helper returned ${key}`);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.join("\n")).toContain("[redacted]");
  });
  it("the home directory, written as ~", () => {
    expect(r("at file:///home/someone/product/x.ts:1:2 and /home/someone")).toBe("at file://~/product/x.ts:1:2 and ~");
    expect(r("/home/someoneelse/x")).toBe("/home/someoneelse/x");                                  // another user's home stays
    expect(r("[/home/someone] {/home/someone} /home/someone.")).toBe("[~] {~} ~.");                 // review L3
    expect(redact("/x/y", "/")).toBe("/x/y");                                                      // a home of "/" is never replaced
  });
});

describe("toLogFormat", () => {
  it("gives the stack (name, message, frames), never other fields such as a body", () => {
    const e = Object.assign(new Error("upstream said no"), { body: "SECRET BODY", response: { text: "SECRET" } });
    const out = toLogFormat(e);
    expect(out).toMatch(/^Error: upstream said no\n\s+at /);
    expect(out).not.toMatch(/SECRET/);
  });
  it("walks the whole cause chain", () => {
    const root = new RangeError("disk full");
    const mid = new Error("write failed", { cause: root });
    const top = new TypeError("save failed", { cause: mid });
    const out = toLogFormat(top);
    expect(out).toMatch(/^TypeError: save failed/);
    expect(out).toMatch(/Caused by: Error: write failed/);
    expect(out).toMatch(/Caused by: RangeError: disk full/);
  });
  it("stops at a depth cap and on a cycle", () => {
    let e: Error = new Error("e0");
    for (let i = 1; i <= 20; i++) e = new Error(`e${i}`, { cause: e });
    expect((toLogFormat(e).match(/Caused by/g) ?? []).length).toBe(5);
    const a = new Error("a"); const b = new Error("b", { cause: a }); (a as { cause?: unknown }).cause = b;
    expect(() => toLogFormat(b)).not.toThrow();
  });
  it("formats what isn't an Error, never an object's values (review L7: a rejected {status, body} logs no body)", () => {
    expect(toLogFormat("plain text")).toBe("plain text");
    expect(toLogFormat({ status: 500, body: "SECRET BODY" })).toBe("[object with keys: status, body]");
    expect(toLogFormat([1, 2])).toBe("[array of 2]");
    expect(toLogFormat(undefined)).toBe("undefined");
    expect(toLogFormat(42)).toBe("42");
    expect(toLogFormat(null)).toBe("null");
  });
});

describe("the logger", () => {
  const capture = (level: Level = "debug") => {
    const lines: { level: Level; line: string }[] = [];
    const log = createLogger({ level, home: HOME, sink: (line, l) => lines.push({ level: l, line }) });
    return { log, lines };
  };
  it("redacts every line through its one sink, error stacks included", () => {
    const { log, lines } = capture();
    log.warn("refused principal@example.test from 100.100.1.2");
    log.error("pair failed for https://box.tailzz.ts.net/pair#t=topsecret", new Error("at /home/someone/x with __Host-morndo=c00kie"));
    const all = lines.map(l => l.line).join("\n");
    expect(all).not.toMatch(/principal@example|100\.100\.1\.2|tailzz|topsecret|c00kie|\/home\/someone/);
    expect(all).toMatch(/\[email\]/);
    expect(all).toMatch(/Error: at ~\/x with __Host-morndo=\[redacted\]/);
  });
  it("drops lines below its level", () => {
    const { log, lines } = capture("warn");
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(lines.map(l => l.level)).toEqual(["warn", "error"]);
  });
  it("prefixes each line with the hub and the level", () => {
    const { log, lines } = capture();
    log.info("listening");
    expect(lines[0]?.line).toBe("[hub] info: listening");
  });
});
