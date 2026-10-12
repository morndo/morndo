---
note: search-grounding-terms
read: "2026-10-12"
recheck: "2027-01-10"
---
# Terms on search-grounded model output

One vendor's API can ground a model's answer in its search engine's results. Its terms limit what may be done with that grounded output, which matters for anything published.

What the template takes from it:
- Grounding stays off in the research and search steps, since a post would modify grounded output and mix it with other content.
- Whether a grounded answer may serve as private research notes for a post someone then writes is a legal question, open for counsel (design, Q10).

## Sources

- Google, Gemini API Additional Terms of Service (effective 2026-03-23), the section on grounding with Google Search. https://ai.google.dev/gemini-api/terms (read 2026-10-12). basis: vendor-doc. Without Google's written permission, grounded results may not be modified or mixed with other content, are shown only with their search suggestions to the end user who asked, and may not be cached, syndicated or analysed.
