// A merge's liveness over the nodes' builds (B11): the domain's livenessOf, with each ancestry answer cached per
// (merge, build) pair — "ancestor" and "not_ancestor" for good (git's answer about those two commits never changes),
// "unknown" only until its TTL, because the operator may have updated the checkout the answer was read from.
import { livenessOf, type AncestryAnswer, type Liveness, type NodeBuild } from "@morndo/domain";

const UNKNOWN_TTL_MS = 30_000;

export class MergeLiveness {
  readonly #builds: () => readonly NodeBuild[];
  readonly #ancestry: (merge: string, build: string) => AncestryAnswer;
  readonly #now: () => number;
  readonly #unknownTtlMs: number;
  readonly #answers = new Map<string, { answer: AncestryAnswer; until: number | null }>();   // "<merge> <build>"

  constructor(o: { builds: () => readonly NodeBuild[]; ancestry: (merge: string, build: string) => AncestryAnswer; now?: () => number; unknownTtlMs?: number }) {
    this.#builds = o.builds;
    this.#ancestry = o.ancestry;
    this.#now = o.now ?? Date.now;
    this.#unknownTtlMs = o.unknownTtlMs ?? UNKNOWN_TTL_MS;
  }

  of(sha: string): Liveness {
    return livenessOf(sha, this.#builds(), (merge, build) => this.#ask(merge, build));
  }

  #ask(merge: string, build: string): AncestryAnswer {
    const key = `${merge} ${build}`;
    const held = this.#answers.get(key);
    const now = this.#now();
    if (held && (held.answer !== "unknown" || held.until !== null && held.until > now)) return held.answer;
    const answer = this.#ancestry(merge, build);
    this.#answers.set(key, answer === "unknown" ? { answer, until: now + this.#unknownTtlMs } : { answer, until: null });
    return answer;
  }
}
