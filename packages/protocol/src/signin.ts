// Sign-in from the app on the wire (ADR-0039). The app talks to the hub; the hub talks to one node through five typed
// fleet operations (fleet.ts). What crosses: a target, the CLI's own sign-in link, a device code, the sign-in's own age
// recipient, and the one-time code sealed to that recipient (FL14: a value sealed to one node's recipient may cross).
// Never a plain code, a token or a credential file. Every schema is strict, so a key it doesn't name is refused whole.
import { SIGNIN_ACCOUNT, SIGNIN_RUNTIMES } from "@morndo/domain";
import { NODE_NAME } from "./worker-id.ts";
import * as z from "./z.ts";

export const SIGNIN_ID = /^si-[A-Za-z0-9_-]{1,64}$/;
// Base64 of the age file that holds the code: a code is short, so a few KiB is far more than enough.
export const SEALED_MAX = 4096;

const node = () => z.string().check(z.regex(NODE_NAME));
const account = () => z.string().check(z.regex(SIGNIN_ACCOUNT));
const signinId = () => z.string().check(z.regex(SIGNIN_ID));
const when = () => z.number().check(z.refine(Number.isFinite, "a time"));
const words = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
export const SignInRuntimeSchema = z.enum(SIGNIN_RUNTIMES as unknown as ["claude", "cursor"]);
export const SealedCode = z.string().check(
  z.minLength(4), z.maxLength(SEALED_MAX), z.regex(/^[A-Za-z0-9+/]+={0,2}$/), z.refine(s => s.length % 4 === 0, "base64"),
);
export const SIGNIN_PHASES = ["waiting", "checking", "done", "failed", "expired", "cancelled"] as const;
const identity = () => z.nullable(z.strictObject({ email: words(320), plan: z.nullable(words(80)) }));

// The app → the hub.
export const StartSignInBody = z.strictObject({ node: node(), runtime: SignInRuntimeSchema, account: account(), create: z._default(z.boolean(), false) });
export const SignInCodeBody = z.strictObject({ sealed: SealedCode });
// An agent → the hub (agent token): asks for a card, nothing more (SI8).
export const RequestSignInBody = z.strictObject({
  node: node(), runtime: SignInRuntimeSchema, account: account(), create: z._default(z.boolean(), false), why: words(300),
});

// The hub → the app. No field for a code, a token or a sealed value (SI6).
export const SignInViewSchema = z.strictObject({
  id: signinId(), node: node(), runtime: SignInRuntimeSchema, account: account(), create: z.boolean(),
  phase: z.enum(SIGNIN_PHASES), link: words(2048), userCode: z.nullable(words(64)), needsCode: z.boolean(),
  recipient: z.nullable(words(200)), startedAt: when(), expiresAt: when(), identity: identity(), problem: z.nullable(words(80)),
});
export type SignInView = z.output<typeof SignInViewSchema>;

export const ACCOUNT_STATES = ["ok", "missing", "unknown"] as const;
// email: the signed-in email, or the last one the account's settings named; shown to the principal, never stored (ADR-0039).
// A node on an agent from before emails leaves it out; that answer still passes, with no email, while nodes update.
export const AccountRowSchema = z.strictObject({
  name: account(), signedIn: z.enum(ACCOUNT_STATES), retired: z.boolean(), plan: z.nullable(words(80)),
  email: z._default(z.nullable(words(320)), null),
});
export type AccountRow = z.output<typeof AccountRowSchema>;
export const AccountsViewSchema = z.strictObject({ node: node(), runtime: SignInRuntimeSchema, accounts: z.array(AccountRowSchema).check(z.maxLength(64)) });
export type AccountsView = z.output<typeof AccountsViewSchema>;

// The fleet operations' arguments and results (registered in fleet.ts).
export const SignInAccountsArgs = z.strictObject({ runtime: SignInRuntimeSchema });
export const SignInAccountsResult = z.strictObject({ accounts: z.array(AccountRowSchema).check(z.maxLength(64)) });
export const SignInStartArgs = z.strictObject({ id: signinId(), runtime: SignInRuntimeSchema, account: account(), create: z.boolean() });
export const SignInStartResult = z.strictObject({
  link: words(2048), userCode: z.nullable(words(64)), needsCode: z.boolean(), recipient: z.nullable(words(200)), expiresAt: when(),
});
export const SignInCodeArgs = z.strictObject({ id: signinId(), sealed: SealedCode });
export const SignInCodeResult = z.strictObject({ accepted: z.boolean() });
export const SignInIdArgs = z.strictObject({ id: signinId() });
export const SignInStatusResult = z.strictObject({ phase: z.enum(SIGNIN_PHASES), identity: identity(), problem: z.nullable(words(80)) });
export const SignInCancelResult = z.strictObject({ cancelled: z.boolean() });
