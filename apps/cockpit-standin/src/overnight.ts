import type { LaneView } from "@morndo/cockpit-api";

export const overnightHistory: Record<string, string[]> = {
  "customer-profile": ["research-history-1"],
  "brand-list": ["partnerships-history-9"],
  "contact-data": ["partnerships-history-8"],
  "outreach-wave-2": ["partnerships-history-11"],
  "comparison-pages": ["seo-history-2"],
  "sequence-a": ["outbound-history-4"],
  "click-floor": ["paid-history-1"],
};

/** Restore the work as it was before a recorded overnight change. */
export function beforeOvernight(lane: LaneView): Partial<LaneView> {
  switch (lane.id) {
    case "brand-list":
      return {
        status: "128 of 200 brands found, 55 fit the profile. Batch 4 is still being filled.",
        steps: lane.steps.map((step, index) => index === 1 ? { ...step, text: "Find the remaining brands for batch 4" } : step),
        made: lane.made.map((item, index) => index === 0 ? { ...item, detail: "128 brands, 55 marked as a fit" } : item),
      };
    case "contact-data":
      return {
        status: "38 contacts have checked email addresses. Contact finder has not looked up batch 4 yet.",
        steps: lane.steps.map((step, index) => index === 1 ? { ...step, text: "Find the contacts for batch 4" } : step),
        made: lane.made.map(item => ({ ...item, detail: "38 decision-makers with checked email addresses" })),
      };
    case "outreach-wave-2":
      return {
        state: "ok", stateWord: "Working", waitsFor: null, short: null, ask: null, acts: [],
        status: "Sender still needs to draft the wave 2 emails.", next: "Draft the retail emails",
        steps: lane.steps.slice(0, 2).map((step, index) => index === 1 ? { ...step, kind: "now" } : step), made: [],
      };
    case "comparison-pages":
      return {
        status: "The first two pages passed the source check and are ready to publish.",
        steps: lane.steps.map((step, index) => index === 1 ? { ...step, kind: "now", text: "Publish pages 1 and 2" }
          : index === 2 ? { ...step, kind: "todo" } : step),
        made: lane.made.slice(2),
      };
    case "sequence-a":
      return {
        state: "ok", stateWord: "Working", closedAt: null, status: "The 14 replied contacts are still in sequence A.",
        steps: lane.steps.map((step, index) => index === 2 ? { ...step, kind: "now", text: "Stop follow-ups for the 14 replies" } : step),
      };
    case "click-floor":
      return {
        state: "ok", stateWord: "Working", closedAt: null, status: "The three ads below the click floor are still running.",
        steps: lane.steps.slice(0, 2).map((step, index) => index === 1 ? { ...step, kind: "now", text: "Switch off the 3 ads below the floor" } : step),
      };
    default:
      return {};
  }
}
