// The Ask a signed-out account files on the Decisions board (ADR-0039): id signin-<node>-<runtime>-<account>, the
// principal's tap opens the sign-in sheet in the app (never answered here), and the hub holds it open until the account
// works again or an agent asked only until then.
import { cardTitle, escalationId, type Ask, type SignInTarget } from "@morndo/domain";

export type SignInCard = {
  id: string;
  target: SignInTarget;
  create: boolean;
  why: string | null;
  askedAt: number;
};

export function signinCardId(target: SignInTarget): string {
  return `signin-${target.node}-${target.runtime}-${target.account}`;
}

export function signinAsk(card: SignInCard): Ask {
  return {
    id: escalationId(card.id),
    asker: { kind: "worker", name: "sign-in", workerId: null },
    need: "time",
    title: cardTitle(card.target, card.create),
    shortTitle: null,
    summary: card.why ?? "Sign it in again from here; it takes about a minute.",
    minutes: 1,
    link: null,
    details: null,
    context: null,
    contextKind: "markdown",
    options: [{ key: "signin", label: "Sign in", detail: null }],
    answerBy: "tap",
    recommendation: null,
    ifNoAnswer: "The other accounts keep the lanes running.",
    deadline: null,
    blocking: false,
    project: null,
    askedAt: card.askedAt,
    messageId: null,
    tracking: "hub",
  };
}
