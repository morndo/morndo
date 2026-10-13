// Secrets on the wire (ADR-0022; design §14 test 2): the wire part of SR3 and SC1. Schemas are strict, so an added key
// is refused whole, and a key named like a value is refused even inside a nested object. The one place bytes may
// travel is SealedValue, an age file sealed to one node, allowed in exactly three schemas. The shape catalog is data
// with a source per shape; the words table covers every term the domain names.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUEST_KINDS, REQUEST_STATES, SECRET_STATUSES, USE_MODES } from "@morndo/domain";
import {
  AgeRecipient, SECRETS_PROMPT, SECRET_WIRE, SECRET_WORDS, SealedValue, SecretReferenceText, SecretRequestedEvent,
  SecretShapeCatalog, StoreSecretBody, parseSecretShapeCatalog,
} from "../src/index.ts";

const BANNED = /value|secret|plaintext|token|password|cipher|^key$/i;
const REF = "secret://example-app/payments-test";
const sealed = (body = "-> X25519 c29tZQ\nYWJj\n--- bWFj\n") => Buffer.from(`age-encryption.org/v1\n${body}`).toString("base64");
const grant = { subject: { kind: "workspace", workspace: "example-app" }, modes: ["exec", "file"], until: { kind: "open" } };
const requested = {
  node: "node-a", reference: REF, kind: "new", lane: "lane-a", workspace: "example-app",
  purpose: "Run the checkout tests", proposed: grant,
};

type Def = { type: string; shape?: Record<string, Schema>; element?: Schema; innerType?: Schema; options?: Schema[] };
type Schema = { _zod: { def: Def } };

// Every key path under a schema whose schema is `target`, walking objects, arrays, nullables and unions.
function pathsTo(schema: Schema, target: unknown, at: string): string[] {
  if (schema === target) return [at];
  const def = schema._zod.def;
  if (def.type === "object" && def.shape) return Object.entries(def.shape).flatMap(([k, s]) => pathsTo(s, target, `${at}.${k}`));
  if (def.type === "array" && def.element) return pathsTo(def.element, target, `${at}[]`);
  if ((def.type === "nullable" || def.type === "optional") && def.innerType) return pathsTo(def.innerType, target, at);
  if (def.type === "union" && def.options) return def.options.flatMap(o => pathsTo(o, target, at));
  return [];
}
// Every object key under a schema, with its path.
function keysOf(schema: Schema, at: string): string[] {
  const def = schema._zod.def;
  if (def.type === "object" && def.shape) return Object.entries(def.shape).flatMap(([k, s]) => [`${at}.${k}`, ...keysOf(s, `${at}.${k}`)]);
  if (def.type === "array" && def.element) return keysOf(def.element, `${at}[]`);
  if ((def.type === "nullable" || def.type === "optional") && def.innerType) return keysOf(def.innerType, at);
  if (def.type === "union" && def.options) return def.options.flatMap(o => keysOf(o, at));
  return [];
}

describe("secrets wire: no value can travel (SR3, SC1)", () => {
  it("no key of any secrets schema is named like a value", () => {
    const keys = Object.entries(SECRET_WIRE).flatMap(([name, s]) => keysOf(s as unknown as Schema, name));
    expect(keys.length).toBeGreaterThan(20);
    const leaf = (path: string) => path.slice(path.lastIndexOf(".") + 1);
    expect(keys.filter(k => BANNED.test(leaf(k)))).toEqual([]);
  });
  it("the walker finds a banned key when there is one (negative control)", () => {
    expect(BANNED.test("value")).toBe(true);
    expect(BANNED.test("key")).toBe(true);
    expect(BANNED.test("keyedFingerprint")).toBe(false);
  });
  it("a request with a value-like key is refused whole, at the top or nested", () => {
    expect(SecretRequestedEvent.safeParse(requested).success).toBe(true);
    for (const k of ["value", "secret", "token", "password", "key"]) {
      expect(SecretRequestedEvent.safeParse({ ...requested, [k]: "x" }).success, k).toBe(false);
      expect(SecretRequestedEvent.safeParse({ ...requested, proposed: { ...grant, [k]: "x" } }).success, `proposed.${k}`).toBe(false);
    }
  });
  it("a request's purpose is plain text of at most 300 characters", () => {
    expect(SecretRequestedEvent.safeParse({ ...requested, purpose: "x".repeat(300) }).success).toBe(true);
    expect(SecretRequestedEvent.safeParse({ ...requested, purpose: "x".repeat(301) }).success).toBe(false);
    expect(SecretRequestedEvent.safeParse({ ...requested, purpose: "" }).success).toBe(false);
    expect(SecretRequestedEvent.safeParse({ ...requested, purpose: "a\u001bb" }).success).toBe(false);
  });
  it("References follow the domain's grammar", () => {
    expect(SecretReferenceText.safeParse(REF).success).toBe(true);
    for (const bad of ["secret://Example/x", "op://a/b", "secret://a/b/c", ""]) expect(SecretReferenceText.safeParse(bad).success, bad).toBe(false);
  });
});

describe("SealedValue: the one place bytes travel", () => {
  it("is allowed in exactly three schemas: the store body, secrets.store, and the answer of secrets.transfer", () => {
    const where = Object.entries(SECRET_WIRE).flatMap(([name, s]) => pathsTo(s as unknown as Schema, SealedValue, name));
    expect(where.sort()).toEqual(["SecretsStoreArgs.sealed", "SecretsTransferResult.sealed", "StoreSecretBody.targets[].sealed"]);
  });
  it("is base64 of an age v1 file, at most 64 KiB of it", () => {
    expect(SealedValue.safeParse(sealed()).success).toBe(true);
    expect(SealedValue.safeParse(Buffer.from("not an age file").toString("base64")).success).toBe(false);
    expect(SealedValue.safeParse(`${sealed()}!`).success).toBe(false);
    const big = sealed("x".repeat(64 * 1024 - 22));
    const over = sealed("x".repeat(64 * 1024 - 21));
    expect(SealedValue.safeParse(big).success).toBe(true);
    expect(SealedValue.safeParse(over).success).toBe(false);
  });
  it("a store body seals once per target node, each to a pinned recipient", () => {
    const recipient = `age1${"q".repeat(58)}`;
    const body = { requestId: "q1", seen: 2, reference: REF, grant, expiry: null, destinations: [], targets: [{ node: "node-a", recipient, sealed: sealed() }] };
    expect(StoreSecretBody.safeParse(body).success).toBe(true);
    expect(StoreSecretBody.safeParse({ ...body, targets: [] }).success).toBe(false);
    expect(StoreSecretBody.safeParse({ ...body, targets: [{ node: "node-a", recipient, sealed: sealed(), value: "x" }] }).success).toBe(false);
    expect(AgeRecipient.safeParse(recipient).success).toBe(true);
    expect(AgeRecipient.safeParse(`age1${"b".repeat(58)}`).success).toBe(false);
    expect(AgeRecipient.safeParse(`age1${"q".repeat(57)}`).success).toBe(false);
  });
});

describe("the token shape catalog (data, with a source per shape)", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../catalog/secret-shapes.json"), "utf8")) as unknown[];
  const catalog = parseSecretShapeCatalog(raw);
  if (!catalog) throw new Error("the shipped shape catalog does not validate");
  it("validates, and an added field fails", () => {
    expect(catalog.length).toBeGreaterThan(0);
    const first = raw[0];
    if (typeof first !== "object" || first === null) throw new Error("empty catalog");
    expect(SecretShapeCatalog.safeParse([{ ...first, extra: 1 }]).success).toBe(false);
  });
  it("every shape has a unique id and an https source checked on a date", () => {
    expect(new Set(catalog.map(s => s.id)).size).toBe(catalog.length);
    for (const s of catalog) {
      expect(s.source.url, s.id).toMatch(/^https:\/\//);
      expect(s.source.checked, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.source.quote.length, s.id).toBeGreaterThan(0);
    }
  });
  it("every pattern finds its prefix with a long body, and not the bare prefix or a short body", () => {
    for (const s of catalog) {
      const re = new RegExp(s.pattern);
      expect(s.pattern.startsWith(s.prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")), s.id).toBe(true);
      expect(re.test(`Bearer ${s.prefix}${"x".repeat(40)}`), s.id).toBe(true);
      expect(re.test(`${s.prefix}`), s.id).toBe(false);
      expect(re.test(`${s.prefix}xxxx`), s.id).toBe(false);
      expect(re.test("an ordinary sentence without a token"), s.id).toBe(false);
    }
  });
});

describe("the words table and the agents' prompt", () => {
  it("has a word for every use mode, request kind, request state and Secret status the domain names", () => {
    expect(Object.keys(SECRET_WORDS.modes).sort()).toEqual([...USE_MODES].sort());
    expect(Object.keys(SECRET_WORDS.kinds).sort()).toEqual([...REQUEST_KINDS].sort());
    expect(Object.keys(SECRET_WORDS.states).sort()).toEqual([...REQUEST_STATES].sort());
    expect(Object.keys(SECRET_WORDS.status).sort()).toEqual([...SECRET_STATUSES].sort());
  });
  it("says for each mode whether the agent's processes can read the value (design §7.0)", () => {
    for (const mode of USE_MODES) expect(SECRET_WORDS.protects[mode].length, mode).toBeGreaterThan(0);
    expect(SECRET_WORDS.protects.inject).not.toBe(SECRET_WORDS.protects.exec);
  });
  it("docs/agents/secrets.md carries the prompt block exactly", () => {
    const doc = readFileSync(join(import.meta.dirname, "../../../docs/agents/secrets.md"), "utf8");
    const m = /<!-- prompt:secrets -->\n([\s\S]*?)<!-- \/prompt:secrets -->/.exec(doc);
    if (!m) throw new Error("no prompt block in docs/agents/secrets.md");
    expect(m[1]).toBe(SECRETS_PROMPT);
  });
  it("the prompt names the commands it relies on", () => {
    for (const cmd of ["request", "run", "disable"]) expect(SECRETS_PROMPT).toContain(`morndo-secrets ${cmd}`);
  });
});
