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

// "STATUS: DONE …" at the start of an agent's answer becomes a pill (agents in this system lead with it). The rule is
// the domain's, so the catch-up's "Says done" and the chat's pill read it the same way.
export { statusOf } from "@morndo/domain";
