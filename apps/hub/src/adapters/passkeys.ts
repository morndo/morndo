// Passkey adapter over @simplewebauthn/server 14 (ADR-0005). Turns browser responses into domain facts:
// "verified, user verified, counter n". User verification is always required (ADR-0004).
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PasskeyCredential } from "@morndo/domain";

// One principal per hub: every passkey belongs to the same WebAuthn user handle.
const PRINCIPAL_HANDLE = new TextEncoder().encode("morndo-principal");

export type Passkeys = ReturnType<typeof passkeys>;

export function passkeys(opts: { rpId: string; rpName: string; origin: string }) {
  return {
    registrationOptions: (p: { deviceName: string; exclude: PasskeyCredential[] }) =>
      generateRegistrationOptions({
        rpName: opts.rpName,
        rpID: opts.rpId,
        userName: "principal",
        userDisplayName: `Morndo principal (${p.deviceName})`,
        userID: PRINCIPAL_HANDLE,
        attestationType: "none",
        excludeCredentials: p.exclude.map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransport[] })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),

    async verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
      const r = await verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin: opts.origin, expectedRPID: opts.rpId, requireUserVerification: true,
      });
      if (!r.verified || !r.registrationInfo) return null;
      const c = r.registrationInfo.credential;
      const credential: PasskeyCredential = { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] };
      return { credential, userVerified: r.registrationInfo.userVerified };
    },

    // No credentials listed: the device offers its own discoverable passkey (sign-in). One listed: step-up for it.
    authenticationOptions: (only: PasskeyCredential[] = []) => generateAuthenticationOptions({
      rpID: opts.rpId, userVerification: "required",
      allowCredentials: only.map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransport[] })),
    }),

    async verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string, credential: PasskeyCredential) {
      const r = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: opts.origin, expectedRPID: opts.rpId, requireUserVerification: true,
        credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: credential.transports as AuthenticatorTransport[] },
      });
      if (!r.verified) return null;
      return { userVerified: r.authenticationInfo.userVerified, newCounter: r.authenticationInfo.newCounter };
    },
  };
}
