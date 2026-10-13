// The template lives in @morndo/protocol so the hub and morndo-decide share one parser.
// This file remains so existing hub imports keep their path.
export { BRIEF_TEMPLATE, briefDue, parseBriefMarkdown } from "@morndo/protocol";
export type { ParsedTemplate } from "@morndo/protocol";
