// The principal's proof on the wire (updates design §5.4, PR 6c): one assertion the hub signs — its payload and the
// signature, both base64url, joined by a "." — travels in the x-morndo-principal header, and the signature is over
// "morndo-principal:" + the payload's exact bytes as sent. Nothing here signs or verifies: the encode/decode pair
// moves bytes, the schema judges the assertion, and the two ends that do cryptography (the hub's signer, the fleet's
// check) meet over exactly these shapes. Pure code, as the whole package is: it runs in the browser too.
import { describe, expect, it } from "vitest";
import {
  PRINCIPAL_HEADER, PRINCIPAL_SIGN_PREFIX, PrincipalAssertionSchema, decodePrincipalHeader,
  encodePrincipalHeader, parsePrincipalAssertion, principalPayloadText, type PrincipalAssertion,
} from "../src/principal.ts";

const NONCE = "ABCDEFGHIJKLMNOPQRSTUV";            // 22 base64url characters: 16 bytes as the fleet mints them
const apply: PrincipalAssertion = { op: "update.apply", version: "0.4.2", node: "pc", exp: 1_791_000_030_000, nonce: NONCE };
const resume: PrincipalAssertion = { op: "rollout.resume", version: "0.4.2", exp: 1_791_000_030_000, nonce: NONCE };
const signature = new Uint8Array(64).fill(7);      // the check only moves these bytes; the signing is elsewhere

describe("the principal's header", () => {
  it("names its header and its signing prefix", () => {
    expect(PRINCIPAL_HEADER).toBe("x-morndo-principal");
    expect(PRINCIPAL_SIGN_PREFIX).toBe("morndo-principal:");
  });

  it("round-trips: decode gives back the payload's exact bytes and the signature; the payload parses as the assertion", () => {
    const text = principalPayloadText(apply);
    const header = encodePrincipalHeader(text, signature);
    const parts = decodePrincipalHeader(header);
    expect(parts).not.toBeNull();
    expect(new TextDecoder().decode(parts!.payload)).toBe(text);
    expect(parts!.signature).toEqual(signature);
    expect(parsePrincipalAssertion(text)).toEqual(apply);
  });

  it("the payload is one canonical spelling: op, version, node only with update.apply, exp, nonce", () => {
    expect(principalPayloadText(apply)).toBe(`{"op":"update.apply","version":"0.4.2","node":"pc","exp":1791000030000,"nonce":"${NONCE}"}`);
    expect(principalPayloadText(resume)).toBe(`{"op":"rollout.resume","version":"0.4.2","exp":1791000030000,"nonce":"${NONCE}"}`);
  });

  it("a malformed header decodes to null, never to a guess", () => {
    // the signature is 64 bytes of base64url (86 characters); every case below breaks the shape somewhere
    const good = encodePrincipalHeader(principalPayloadText(resume), signature);
    const [payload, sig] = good.split(".");
    const cases = [
      "",                                   // nothing
      payload!,                             // no "." at all
      `${payload}!${sig}`,                  // a separator that is not base64url
      `${payload}.${sig}${sig}`,            // a signature twice as long
      `${payload}`,                         // one part only, again
      `.${sig}`,                            // an empty payload
      `${payload}.`,                        // an empty signature
      `${payload}.A`,                       // a signature that is not 64 bytes
      `not-base64url+chars.${sig}`,         // a payload outside the alphabet
      `${payload}.${sig!.slice(0, -1)}`,    // one character short
    ];
    for (const bad of cases) expect(decodePrincipalHeader(bad), bad).toBeNull();
    expect(decodePrincipalHeader(good)).not.toBeNull();
  });

  it("an assertion the schema refuses parses to null", () => {
    const as = (v: unknown) => JSON.stringify(v);
    expect(parsePrincipalAssertion(as({ op: "rollout.resume", version: "0.4.2", node: "pc", exp: 1, nonce: NONCE }))).toBeNull();   // a node where resume has none
    expect(parsePrincipalAssertion(as({ op: "update.apply", version: "0.4.2", exp: 1, nonce: NONCE }))).toBeNull();                 // update.apply without its node
    expect(parsePrincipalAssertion(as({ op: "update.apply", version: "0.4.2", node: "pc", exp: -1, nonce: NONCE }))).toBeNull();    // a time before the epoch
    expect(parsePrincipalAssertion(as({ op: "update.apply", version: "0.4.2+x", node: "pc", exp: 1, nonce: NONCE }))).toBeNull();   // build metadata on a Release's Version
    expect(parsePrincipalAssertion(as({ op: "update.apply", version: "0.4.2", node: "pc", exp: 1, nonce: "short" }))).toBeNull();   // a nonce of no shape
    expect(parsePrincipalAssertion(as({ op: "pane.send", version: "0.4.2", node: "pc", exp: 1, nonce: NONCE }))).toBeNull();        // an op that is not the principal's
    expect(parsePrincipalAssertion(as({ op: "update.apply", version: "0.4.2", node: "pc", exp: 1, nonce: NONCE, extra: 1 }))).toBeNull(); // an unknown field
    expect(parsePrincipalAssertion("not json")).toBeNull();
    expect(PrincipalAssertionSchema.safeParse(apply).success).toBe(true);
  });
});
