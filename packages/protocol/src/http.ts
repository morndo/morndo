// The JSON bodies the app posts to the hub (ADR-0004, ADR-0006). Unknown fields are dropped; a body that doesn't fit
// is refused with 400 before any service sees it.
import * as z from "./z.ts";
import { LIMITS } from "./fleet.ts";

const text = (max: number) => z.string().check(z.maxLength(max));
// What a browser's WebAuthn call returned; the passkey library checks the rest.
const webauthnResponse = z.looseObject({ id: text(1024), type: z.literal("public-key"), response: z.looseObject({}) });
// Each Command, and each Decision, is sent with its own id, the same for every retry (S5).
const requestId = z.uuid();

export const IdentityProveBody = z.object({ nonce: text(200) });
const code = () => z.string().check(z.regex(/^\d{6}$/));
// `code`: what the new device typed of the issuing device's code (amendment 11).
export const PairOptionsBody = z.object({ token: text(200), name: z.exactOptional(text(200)), code: z.exactOptional(code()) });
export const PasskeyVerifyBody = z.object({ flowId: text(100), response: webauthnResponse });
export const PolicyBody = z.object({ stay: text(20), stepUp: text(20) });
// Phase E: the pairing screen's look at its token, and an answer to a Link request (with the hub identity the
// approving device pinned, for the new device's fingerprint check).
export const PairCheckBody = z.object({ token: text(200) });
// An approval carries the pinned identity and its proof: HMAC-SHA256 under the key from the new device's QR code,
// base64url (review M1). A denial carries nothing.
export const LinkDecisionBody = z.object({
  fingerprint: z.exactOptional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
  proof: z.exactOptional(z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/))),
  code: z.exactOptional(code()),                                     // what the approver typed of the new device's code
});
export const SendBody = z.object({
  text: text(LIMITS.maxMessageText),
  requestId,
  // S6: what the principal saw the worker wait for when he wrote it: "none", or a question or menu identity.
  seen: text(2000),
  uploads: z.exactOptional(z.array(text(64)).check(z.maxLength(12))),
  // The worker's name it was written to: a pane id tmux gave out again after a restart names another agent, and a Retry
  // up to a day later must not type into it (whole-branch review M2). Absent from an older app: no check.
  name: z.exactOptional(text(200)),
  // When the principal wrote it, on the device's clock (S7). The hub's notAfter counts from this, not from arrival.
  // Absent from an older app: the hub uses its own arrival time.
  createdAt: z.exactOptional(z.number().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER))),
  // Set only by the phone's Send again (ADR-0011) of a message to the manager the queue gave up: queued once more, as a
  // new attempt. A plain repeat, the phone's status check included, is a read and never queues another copy.
  again: z.exactOptional(z.boolean()),
});
// The principal's cancel of one of his messages to the manager still waiting in the fleet's delivery queue (ruling 83).
export const CancelBody = z.object({ requestId });
export type CancelBody = z.output<typeof CancelBody>;
// `seen`: the version of the ask the answer was given for (askVersion; review of PR #7, finding 5). Optional: the
// desktop answers at once.
const seen = z.exactOptional(text(64));
export const AnswerBody = z.union([
  z.object({ key: text(200), requestId, seen }),
  z.object({ text: text(100_000), requestId, seen }),
]);

export type SendBody = z.output<typeof SendBody>;
export type AnswerBody = z.output<typeof AnswerBody>;
