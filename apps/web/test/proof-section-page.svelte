<script lang="ts">
  // ProofSection (ADR-0035 step 5): one cell per scenario the component tests cover.
  import ProofSection from "../src/lib/desktop/ProofSection.svelte";
  import type { ProofView } from "../src/lib/desktop/board.ts";
  import type { TaskStatus } from "@morndo/domain";

  const PR = "acme/shop#42@3e9d1a7";
  const CI = "acme/shop@3e9d1a7:ci,lint";
  const MISMATCH = "acme/shop#43@1111111";
  const PRIVATE = "morndo/morndo#7@3e9d1a7";
  const RUN = "https://github.com/morndo/morndo/actions/runs/9";

  const brief = (refs: string[], attested: { kind: "tests" | "ui"; how: string }[] = []) => ({
    summary: "Totals row rounds to cents",
    decisions: "round at display",
    leftOut: "nothing",
    limits: "locale formats not covered",
    refs,
    attested,
    noCode: "",
  });

  const verified: ProofView = {
    rev: 4,
    brief: brief([PR, CI]),
    results: [
      { ref: PR, state: "green", detail: null, checkedAt: 1 },
      { ref: CI, state: "green", detail: null, checkedAt: 2 },
    ],
    mode: "on",
    standIn: false,
    coverage: [],
    state: { kind: "verified", green: 2, total: 2, accepts: true, line: "proof: 2 of 2 green" },
  };

  const failing: ProofView = {
    rev: 5,
    brief: brief([PR, CI, MISMATCH], [{ kind: "tests", how: "npm test: 48 passed" }]),
    results: [
      { ref: PR, state: "green", detail: null, checkedAt: 1 },
      { ref: CI, state: "red", detail: `"lint" failed ${RUN}`, checkedAt: 2 },
      { ref: MISMATCH, state: "mismatch", detail: "head is 2222222, ref says 1111111", checkedAt: 3 },
    ],
    mode: "on",
    standIn: false,
    coverage: [],
    state: {
      kind: "failing",
      green: 1,
      total: 3,
      accepts: false,
      line: `proof: 1 of 3 green · ✗ ${CI} "lint" failed ${RUN} · ≠ ${MISMATCH} mismatch`,
    },
  };

  const noBrief: ProofView = {
    rev: null,
    brief: null,
    results: [],
    mode: "on",
    standIn: false,
    coverage: [],
    state: { kind: "no_brief", green: 0, total: 0, accepts: false, line: "proof: no brief" },
  };

  const notChecked: ProofView = {
    rev: 6,
    brief: brief([PRIVATE]),
    results: [{ ref: PRIVATE, state: "not_checked", detail: "private repo: not checked", checkedAt: 1 }],
    mode: "on",
    standIn: false,
    coverage: [],
    state: { kind: "not_checked", green: 0, total: 1, accepts: false, line: `proof: 0 of 1 green · ○ ${PRIVATE} not checked` },
  };

  const pendingRef: ProofView = {
    rev: 7,
    brief: brief([PR, CI]),
    results: [{ ref: PR, state: "green", detail: null, checkedAt: 1 }],
    mode: "on",
    standIn: false,
    coverage: [],
    state: { kind: "pending", green: 1, total: 2, accepts: false, line: `proof: 1 of 2 green · … ${CI} pending` },
  };

  const needsList: ProofView = {
    rev: 8,
    brief: brief([PR]),
    results: [{ ref: PR, state: "green", detail: null, checkedAt: 1 }],
    mode: "on",
    standIn: false,
    coverage: [
      { spec: "pr@acme/shop: the pull request", kind: "pr", repo: "acme/shop", text: "the pull request", by: "assigner", status: "covered" },
      { spec: "data: a sample of 30 rows", kind: "data", repo: null, text: "a sample of 30 rows", by: "assigner", status: "not_covered" },
      { spec: "ci@acme/shop: CI green", kind: "ci", repo: "acme/shop", text: "CI green", by: "assigner", status: "open" },
      { spec: "tests: npm test passed", kind: "tests", repo: null, text: "npm test passed", by: "lane", status: "told" },
    ],
    state: {
      kind: "not_covered",
      green: 1,
      total: 1,
      accepts: false,
      line: "proof: 1 of 1 green · ◇ not covered: data: a sample of 30 rows",
    },
  };

  const cell = (name: string, proof: ProofView, status: TaskStatus) => ({ name, proof, status });
  const cells = [
    cell("verified", verified, "review"),
    cell("failing", failing, "review"),
    cell("no-brief", noBrief, "review"),
    cell("not-checked", notChecked, "review"),
    cell("doing-empty", noBrief, "doing"),
    cell("pending-ref", pendingRef, "review"),
    cell("stand-in", { ...verified, standIn: true }, "review"),
    cell("needs-list", needsList, "review"),
  ];
</script>

<div class="row">
  {#each cells as { name, proof, status }}
    <div class="cell" data-cell={name}>
      <ProofSection {proof} status={status} />
    </div>
  {/each}
</div>

<style>
  .row { display: flex; flex-wrap: wrap; }
  .cell { width: 400px; min-height: 320px; padding: 8px; border: 1px solid var(--border); }
  .cell[data-cell="needs-list-narrow"] { width: 390px; max-width: 390px; }
</style>
