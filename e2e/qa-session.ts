// Manual QA in a browser whose passkeys belong to someone else (the box's shared agent Chrome, whose password manager
// takes over WebAuthn, so a test authenticator never sees the request): a signed-in session for a demo office
// (e2e/demo-office.ts), written straight into that office's own database, so the app can be used there without creating
// a passkey in anyone's account. The device's credential is made up and can't sign in again; the session is verified
// now, as after a passkey check. Synthetic only: any MORNDO_HOME outside the system's temp dir is refused, so the live
// hub's data can't be touched.
//   node e2e/qa-session.ts <the demo's MORNDO_HOME> [device name]   prints the value for the __Host-morndo cookie
//   node e2e/qa-session.ts <the demo's MORNDO_HOME> --reverify <cookie value>   as if its passkey were checked again now
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { endpointId, pairingTokenId, sessionId } from "@morndo/domain";
import { Store } from "../apps/hub/src/adapters/store.ts";
import { hashSecret } from "../apps/hub/src/application/access-service.ts";

const [home = "", a = "", b = ""] = process.argv.slice(2);
const real = existsSync(home) ? realpathSync(home) : "";
if (!real.startsWith(realpathSync(tmpdir()) + sep) || !basename(real).startsWith("morndo-") || !existsSync(join(real, "morndo.db"))) {
  console.error(`refused: ${home || "(none)"} isn't a demo office's MORNDO_HOME under ${tmpdir()}`);
  process.exit(2);
}
const store = new Store(real);
const now = Date.now();
if (a === "--reverify") {
  const s = store.session(hashSecret(b));
  if (!s) { console.error("no such session"); process.exit(1); }
  store.saveSession({ ...s, verifiedAt: now, lastSeenAt: now });
  console.log("verified now");
} else {
  const secret = randomBytes(32).toString("base64url"), id = `qa-${randomBytes(4).toString("hex")}`;
  store.transaction(() => {
    store.saveEndpoint({
      id: endpointId(id), name: a || "QA browser", credential: { id, publicKey: new Uint8Array([0]), counter: 0, transports: [] },
      pairedAt: now, pairedWith: pairingTokenId("qa-seeded"), lastSeenAt: now, revokedAt: null,
    });
    store.saveSession({ id: sessionId(hashSecret(secret)), endpointId: endpointId(id), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null });
  });
  console.log(secret);
}
store.db.close();
