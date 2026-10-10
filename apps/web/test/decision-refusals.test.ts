// Every refusal the hub can answer a Decision with has words, so none reaches the principal as the hub's bare code: one
// map (desktop/decisions.ts REFUSALS) for the desktop's answer (Desktop.svelte) and the phone's catch-up and Today
// (catchup/answer.ts). The codes are the hub's AnswerResult problems (apps/hub/src/application/escalation-service.ts),
// but step_up, which each path handles by asking for the passkey first. A fleet adds two (fleet core §4, §7; Tasks 5,
// 14): the manager's machine doesn't answer (node_offline), and two windows claim the manager's name (lane_conflict).
// Nothing was typed in either. Pure; no hub.
import { describe, expect, it } from "vitest";
import type { AnswerRefusal } from "@morndo/domain";
import { SEND_REFUSALS } from "../../hub/src/application/ports.ts";
import { ApiError } from "../src/lib/api.ts";
import { MAY_HAVE_GONE, againLabel, postAnswer } from "../src/lib/catchup/answer.ts";
import { REFUSALS } from "../src/lib/desktop/decisions.ts";

// The domain's AnswerRefusal, all of it: one added there fails the type check here until it is listed, and so worded.
const ANSWER_REFUSALS = ["unknown", "already_answered", "settled", "expired", "not_filed_yet", "cant_check", "on_screen", "not_a_choice", "bad_option", "empty"] as const satisfies readonly AnswerRefusal[];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const allRefusals: Same<(typeof ANSWER_REFUSALS)[number], AnswerRefusal> = true;
const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;   // node-ops' SendProblem
const THE_HUBS_OWN = ["in_progress", "too_long", "changed", "node_offline", "lane_conflict"] as const;

describe("words for every refusal of an answer", () => {
  it("each code the hub can send has its own words", () => {
    expect(allRefusals).toBe(true);
    expect([...ANSWER_REFUSALS, ...SEND_PROBLEMS, ...THE_HUBS_OWN].filter(code => !REFUSALS[code])).toEqual([]);
  });
  it("a fleet's two say nothing was typed, and what to do", () => {
    expect(REFUSALS.node_offline).toBe("The manager's machine isn't answering right now, so the answer wasn't typed. Try again once it's back.");
    expect(REFUSALS.lane_conflict).toBe("Two windows are named like the manager, so the answer wasn't typed: nobody can tell which one it's for. Close or rename one of them, then try again.");
  });
  // The fix wave: a refusal from the node or the fleet that says nothing ran (the hub's SEND_REFUSALS, executed "no",
  // bad_args from the fleet's schema check among them) reaches the app as its code, and an answer the asker's machine
  // may have typed as "uncertain" (409). Each has words; "uncertain" is one to check again with the same request id.
  it("every refusal the fleet can answer an answer with, and an answer in doubt, has words (the hub's list: one added fails here)", async () => {
    expect([...SEND_REFUSALS, "uncertain"].filter(code => !REFUSALS[code])).toEqual([]);
    expect(REFUSALS.uncertain).toBe("May have been sent. Check again asks whether it was typed; if that can't be known, it stays here, so look at the manager's screen before answering again.");
    expect(REFUSALS.uncertain).not.toMatch(/types it|lost touch/);       // no promise Check again can't keep (the residual round)
    for (const code of SEND_REFUSALS) expect(REFUSALS[code], code).toMatch(/wasn't typed/);
    expect(await postAnswer("ny-7", { key: "ship" }, "v1", "req-u", async () => { throw new ApiError(409, "uncertain"); }))
      .toEqual({ ok: false, code: "uncertain", text: REFUSALS.uncertain });
    expect(MAY_HAVE_GONE.has("uncertain")).toBe(true);                 // the phone sends the same request id again
    expect(SEND_REFUSALS.filter(code => MAY_HAVE_GONE.has(code))).toEqual([]);   // nothing ran: nothing to check
    expect([againLabel("uncertain"), againLabel("unknown")]).toEqual(["Check again", "Try again"]);
  });
  it("the phone's catch-up gives the same words", async () => {
    for (const code of ["node_offline", "lane_conflict"]) {
      const r = await postAnswer("ny-7", { key: "ship" }, "v1", `req-${code}`, async () => { throw new ApiError(409, code); });
      expect(r).toEqual({ ok: false, code, text: REFUSALS[code] });
    }
  });
});
