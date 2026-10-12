// Agent text is untrusted (prompt injection can put anything in it): render markdown, then sanitize every time.
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "img", "iframe", "form", "input", "button", "svg", "math"],
    FORBID_ATTR: ["style", "class", "id"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

// The brief's own subset (ADR-0023 DB7, design §6.6). What lint accepts, this shows; headings, raw HTML, images and
// any link that is not https are dropped here even though lint already refused them. The tag list is the allowlist:
// a test keeps it equal to the subset.
export const BRIEF_MARKDOWN_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote", "a", "table", "thead", "tbody", "tr", "th", "td"] as const;

export function renderBriefMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...BRIEF_MARKDOWN_TAGS],
    ALLOWED_ATTR: ["href", "target", "rel"],
    ALLOWED_URI_REGEXP: /^https:/i,
  });
}

// "STATUS: DONE …" at the start of an agent's answer becomes a pill (agents in this system lead with it). The rule is
// the domain's, so the catch-up's "Says done" and the chat's pill read it the same way.
export { statusOf } from "@morndo/domain";
