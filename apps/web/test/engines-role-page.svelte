<script lang="ts">
  // A RoleCard the engines-role test drives: the other-provider switch, and a typed effort the draft can refuse.
  import RoleCard from "../src/lib/engines/RoleCard.svelte";
  import type { EngineProvider, RoleEngines } from "@morndo/domain";

  const listed: EngineProvider = {
    name: "claude", label: "Claude", kind: "cli", models: ["opus-5.5", "x"], efforts: ["high"],
    availability: "ready", until: null, pausedModels: [],
  };
  const free: EngineProvider = {
    name: "free", label: "Free", kind: "cli", models: ["x"], efforts: null,
    availability: "ready", until: null, pausedModels: [],
  };
  let backend = $state<RoleEngines>({
    role: "implement-backend", label: "Implement: backend",
    chain: [{ provider: "claude", model: "opus-5.5", effort: "high" }],
    riskChain: null, otherProvider: true,
  });
  let open = $state<RoleEngines>({
    role: "plan", label: "Plan",
    chain: [{ provider: "free", model: "x", effort: "high" }, { provider: "free", model: "x", effort: "" }],
    riskChain: null, otherProvider: false,
  });
</script>

<section data-case="rule">
  <RoleCard role={backend} changed={true} now={{ engine: null, skipped: [] }} providers={[listed]}
    onChange={next => (backend = next)} />
</section>
<section data-case="effort">
  <RoleCard role={open} changed={true} now={{ engine: null, skipped: [] }} providers={[free]}
    onChange={next => (open = next)} />
</section>
