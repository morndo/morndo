<script lang="ts" module>
  export type Policy = { stay: "12h" | "7d" | "30d"; stepUp: "10m" | "1h" | "8h" | "signin" };
  export const STEP_UP_MS: Record<Policy["stepUp"], number | null> = { "10m": 10 * 60_000, "1h": 3_600_000, "8h": 8 * 3_600_000, signin: null };
</script>

<script lang="ts">
  // The principal's access policy (AC5, AC7, AC8). The hub stores and enforces it; making it looser needs the passkey
  // once, making it stricter never does. Used in the desktop Preferences modal and on the phone's Devices page.
  import { startAuthentication } from "@simplewebauthn/browser";
  import { api, ApiError, explain } from "./api.ts";

  let { policy, onChanged, onVerified = () => {} }: { policy: Policy; onChanged: (p: Policy) => void; onVerified?: (at: number) => void } = $props();
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let version = $state(0);                                // re-renders the radios when a change is refused

  const STEP_UP: [Policy["stepUp"], string, string][] = [
    ["10m", "Every 10 minutes", "Strictest."],
    ["1h", "Every hour", "Default."],
    ["8h", "Every 8 hours", "About once a working day."],
    ["signin", "Only when I sign in", "The sign-in's Face ID or Touch ID is enough."],
  ];
  const STAY: [Policy["stay"], string, string][] = [
    ["12h", "12 hours", "Signs out after 2 hours without use."],
    ["7d", "7 days", "Default. Signs out after a day without use."],
    ["30d", "30 days", "Signs out after 7 days without use."],
  ];

  async function choose(patch: Partial<Policy>) {
    const next = { ...policy, ...patch };
    busy = true;
    problem = null;
    try {
      const post = () => api.post<{ policy: Policy }>("/api/policy", next);
      let r;
      try { r = await post(); }
      catch (e) {
        if (!(e instanceof ApiError && e.code === "step_up")) throw e;
        const { flowId, options } = await api.post<{ flowId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/stepup/options");
        await api.post("/api/stepup/verify", { flowId, response: await startAuthentication({ optionsJSON: options }) });
        onVerified(Date.now());
        r = await post();
      }
      onChanged(r.policy);
    } catch (e) {
      problem = explain(e);
      version++;
    } finally {
      busy = false;
    }
  }
</script>

{#key version}
<div class="field">
  <strong>Ask for my passkey before sending</strong>
  <p class="note">How often Face ID or Touch ID confirms it's you before a message goes into an agent.</p>
  {#each STEP_UP as [value, label, note]}
    <label class="opt"><input type="radio" name="stepUp" id="stepup-{value}" checked={policy.stepUp === value} disabled={busy} onchange={() => choose({ stepUp: value })} />
      <span><b>{label}</b>. {note}</span></label>
  {/each}
</div>
<div class="field">
  <strong>Stay signed in</strong>
  {#each STAY as [value, label, note]}
    <label class="opt"><input type="radio" name="stay" id="stay-{value}" checked={policy.stay === value} disabled={busy} onchange={() => choose({ stay: value })} />
      <span><b>{label}</b>. {note}</span></label>
  {/each}
  <p class="note">Making these looser asks for your passkey once. Making them stricter never does.</p>
  {#if problem}<p class="err">{problem}</p>{/if}
</div>
{/key}
