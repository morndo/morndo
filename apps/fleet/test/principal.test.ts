// The principal's proof at the fleet (updates design §5.4, PR 6c): resume and update.apply stay closed until a check
// says yes, and the check is the hub's signed assertion in x-morndo-principal — Ed25519 over "morndo-principal:" plus
// the payload's exact bytes, under the hub's public key: pinned by the config's principalKey, or, without a pin, read
// from the hub's own identity.pub at each check (PR 6c round 2, R2 — the fleet starts before the hub). The fleet
// verifies the signature, the exp window (in the future, at most 60 s ahead), that the assertion asks for exactly
// this request (op, Version, node), and that the nonce was never spent. Commit and halt stay closed either way
// (§4.5: they come by the internal paths).
import { generateKeyPairSync, randomBytes, sign as signEd } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAP_UPDATE, PRINCIPAL_HEADER, PRINCIPAL_SIGN_PREFIX, encodePrincipalHeader, principalPayloadText,
  type PrincipalAssertion,
} from "@morndo/protocol";
import { productVersion } from "@morndo/service-kit";
import { startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";
import { client } from "./helpers/socket-client.ts";

const V = productVersion();                              // the Version this tree runs: the control plane's own
type Body = Record<string, any>;
const bodyOf = async (answer: Promise<{ body: unknown } | null>): Promise<Body | undefined> => (await answer)?.body as Body | undefined;

describe("the principal's proof at the fleet (updates §5.4)", () => {
  const hub = generateKeyPairSync("ed25519");           // the hub's identity, as the pinned key knows it
  const stranger = generateKeyPairSync("ed25519");      // a key the fleet never pinned
  const principalKey = (hub.publicKey.export({ format: "jwk" }) as { x: string }).x;   // 32 raw bytes, base64url
  const rawOf = (pair: { publicKey: { export(o: { format: string }): unknown } }): Buffer =>
    Buffer.from((pair.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const nonce = () => randomBytes(16).toString("base64url");

  // One assertion as the hub signs it: over "morndo-principal:" + the payload's exact bytes as sent, both parts base64url.
  const headerOf = (a: PrincipalAssertion, key = hub.privateKey): Record<string, string> => {
    const text = principalPayloadText(a);
    const signature = signEd(null, Buffer.from(PRINCIPAL_SIGN_PREFIX + text), key);
    return { [PRINCIPAL_HEADER]: encodePrincipalHeader(text, new Uint8Array(signature)) };
  };
  const resumeAsk = (at: number, over: Partial<PrincipalAssertion> = {}): PrincipalAssertion =>
    ({ op: "rollout.resume", version: V, exp: at + 30_000, nonce: nonce(), ...over });
  const haltedRollout = async (fleet: Awaited<ReturnType<typeof startTestFleet>>, machine: string, reason: string) => {
    fleet.rollouts.committed(V);
    fleet.rollouts.halt(V, machine, reason);
  };

  it("a good assertion lifts a halt; every wrong one is 403 not_allowed, and the halt stands through them all", async () => {
    let now = Date.UTC(2026, 9, 1);
    const fleet = await startTestFleet({ config: { principalKey }, now: () => now });
    const api = client(fleet.config.socketPath);
    await haltedRollout(fleet, "n1", "a node rolled back");
    // no proof at all
    expect(await api.post("/v1/rollout/resume", { version: V })).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    const wrongs: [string, Record<string, string>][] = [
      ["past its exp", headerOf(resumeAsk(now, { exp: now - 1 }))],
      ["too far ahead (over 60 s)", headerOf(resumeAsk(now, { exp: now + 60_001 }))],
      ["another op's proof", headerOf(resumeAsk(now, { op: "update.apply", node: "n2" }))],
      ["another Version's proof", headerOf(resumeAsk(now, { version: "0.0.0-rc.9" }))],
      ["another key's signature", headerOf(resumeAsk(now), stranger.privateKey)],
    ];
    for (const [what, headers] of wrongs) {
      const answer = await client(fleet.config.socketPath, headers).post("/v1/rollout/resume", { version: V });
      expect(answer, what).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    }
    expect(fleet.audit.of("rollout.resumed")).toHaveLength(0);
    expect((await bodyOf(api.get("/v1/rollout")))?.rollout?.halted).toBe(true);
    const good = await client(fleet.config.socketPath, headerOf(resumeAsk(now))).post("/v1/rollout/resume", { version: V });
    expect(good).toMatchObject({ status: 200 });
    expect(good?.body).toMatchObject({ rollout: { version: V, halted: false } });
    expect(fleet.audit.of("rollout.resumed")).toHaveLength(1);
  });

  it("a spent nonce never opens a second door: the replay is refused by the proof, not by the halt", async () => {
    let now = Date.UTC(2026, 9, 1);
    const fleet = await startTestFleet({ config: { principalKey }, now: () => now });
    const api = client(fleet.config.socketPath);
    await haltedRollout(fleet, "n1", "first halt");
    const once = headerOf(resumeAsk(now));
    expect(await client(fleet.config.socketPath, once).post("/v1/rollout/resume", { version: V })).toMatchObject({ status: 200 });
    fleet.rollouts.halt(V, "n2", "halted again");
    // the authority speaks before the halt does: a replay is 403 not_allowed, never 409 not_halted
    expect(await client(fleet.config.socketPath, once).post("/v1/rollout/resume", { version: V })).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    expect((await bodyOf(api.get("/v1/rollout")))?.rollout?.halted).toBe(true);
    // the same ask with a fresh nonce still works
    expect(await client(fleet.config.socketPath, headerOf(resumeAsk(now))).post("/v1/rollout/resume", { version: V })).toMatchObject({ status: 200 });
  });

  it("with no pinned key and no identity.pub to read, the doors stay shut even to a good assertion (closed as today)", async () => {
    const fleet = await startTestFleet({ now: () => Date.now(), principalKeyFile: join(tempDir(), "identity.pub") });   // nothing is written there
    await haltedRollout(fleet, "n1", "a node rolled back");
    const answer = await client(fleet.config.socketPath, headerOf(resumeAsk(Date.now()))).post("/v1/rollout/resume", { version: V });
    expect(answer).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    expect((await bodyOf(client(fleet.config.socketPath).get("/v1/rollout")))?.rollout?.halted).toBe(true);
  });

  // PR 6c round 2, R2: nothing installed the hub's public key anywhere, so a production fleet without a pinned
  // principalKey stayed closed. Now the hub writes <dataDir>/identity.pub at each start, and the fleet reads it at
  // each check — the fleet starts before the hub, so the file may arrive (or change) after the fleet did.
  it("without a pinned key the hub's identity.pub opens the doors, read afresh at each check", async () => {
    let now = Date.UTC(2026, 9, 1);
    const pub = join(tempDir(), "identity.pub");
    const fleet = await startTestFleet({ now: () => now, principalKeyFile: pub });
    await haltedRollout(fleet, "n1", "a node rolled back");
    // no file yet — the hub has not started since the fleet did: closed, like any wrong proof
    expect(await client(fleet.config.socketPath, headerOf(resumeAsk(now))).post("/v1/rollout/resume", { version: V }))
      .toMatchObject({ status: 403, body: { error: "not_allowed" } });
    // the hub starts and writes it; the fleet, already running, reads it now
    writeFileSync(pub, `${rawOf(hub).toString("base64")}\n`, { mode: 0o644 });
    const good = await client(fleet.config.socketPath, headerOf(resumeAsk(now))).post("/v1/rollout/resume", { version: V });
    expect(good).toMatchObject({ status: 200 });
    expect(good?.body).toMatchObject({ rollout: { version: V, halted: false } });
    // and reads it again on every check: a file that stops being a 32-byte key closes them again
    writeFileSync(pub, `${Buffer.alloc(31, 7).toString("base64")}\n`);
    fleet.rollouts.halt(V, "n2", "halted again");
    expect(await client(fleet.config.socketPath, headerOf(resumeAsk(now))).post("/v1/rollout/resume", { version: V }))
      .toMatchObject({ status: 403, body: { error: "not_allowed" } });
  });

  it("a pinned principalKey wins over the file: the config's key decides, whoever the file names", async () => {
    let now = Date.UTC(2026, 9, 1);
    const pub = join(tempDir(), "identity.pub");
    writeFileSync(pub, `${rawOf(stranger).toString("base64")}\n`, { mode: 0o644 });
    const fleet = await startTestFleet({ config: { principalKey }, now: () => now, principalKeyFile: pub });
    await haltedRollout(fleet, "n1", "a node rolled back");
    // the file names the stranger, the config the hub: the hub's proof opens, the stranger's does not
    expect(await client(fleet.config.socketPath, headerOf(resumeAsk(now))).post("/v1/rollout/resume", { version: V }))
      .toMatchObject({ status: 200 });
    fleet.rollouts.halt(V, "n2", "halted again");
    expect(await client(fleet.config.socketPath, headerOf(resumeAsk(now), stranger.privateKey)).post("/v1/rollout/resume", { version: V }))
      .toMatchObject({ status: 403, body: { error: "not_allowed" } });
    expect((await bodyOf(client(fleet.config.socketPath).get("/v1/rollout")))?.rollout?.halted).toBe(true);
  });

  it("update.apply: a good assertion for (n2, V) is forwarded; another node's or Version's proof is not_allowed and nothing is sent", async () => {
    let now = Date.UTC(2026, 9, 1);
    const fleet = await startTestFleet({ config: { principalKey }, now: () => now });
    const n2 = await fleet.online("n2", { caps: [CAP_UPDATE] });
    const n3 = await fleet.online("n3", { caps: [CAP_UPDATE] });
    const applyAsk = (node: string, over: Partial<PrincipalAssertion> = {}): PrincipalAssertion =>
      ({ op: "update.apply", version: V, node, exp: now + 30_000, nonce: nonce(), ...over });
    const apply = (node: string, headers: Record<string, string>) =>
      client(fleet.config.socketPath, headers).post("/v1/op", { node, op: "update.apply", args: { version: V }, key: "hub:u-principal" });
    const good = await apply("n2", headerOf(applyAsk("n2")));
    expect(good?.body).toMatchObject({ ok: true, result: { accepted: true } });
    expect(n2.reqs.filter(r => r.op === "update.apply")).toHaveLength(1);
    const refused = [
      ["another node's proof", await apply("n2", headerOf(applyAsk("n3")))],
      ["another Version's proof", await apply("n2", headerOf(applyAsk("n2", { version: "0.0.0-rc.9" })))],
    ] as [string, { body: Body } | null][];
    for (const [what, answer] of refused) expect(answer?.body, what).toMatchObject({ ok: false, error: { code: "not_allowed", executed: "no" }, store: null, storeSeq: null });
    expect(n2.reqs.filter(r => r.op === "update.apply")).toHaveLength(1);
    expect(n3.reqs.filter(r => r.op === "update.apply")).toHaveLength(0);
  });
});
