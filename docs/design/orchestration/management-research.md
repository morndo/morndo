# What management research says about running agents

**Phase: design, 2026-11-20.** Morndo is an organisation: an owner, managers, lanes, people and agents. Organisation
and human-factors research has studied that shape for decades. This note keeps what applies, what it changes in
Morndo, and where the change lives. The mockups already show the UI parts; the system parts are proposals for the
stability layer in [tmux-architectures.html](tmux-architectures.html).

How strong the evidence is varies, and each finding says so. The two studies of agent systems are recent preprints;
the medical studies are about people, so their transfer to agents is an analogy.

## The findings, and what each changes

| # | Finding | What it changes in Morndo | Where |
|---|---|---|---|
| 1 | **Attention is the scarce resource.** Interrupted people finish faster but with more stress (Mark et al. 2008); an unfinished task leaves "attention residue" that hurts the next (Leroy 2009); in a randomised trial, notifications batched three times a day improved attention and well-being (Fitz et al. 2019). | Reports wait for the next brief, three a day by default. Between briefs Morndo interrupts only for a decision due before the next brief, or something stuck that puts a deadline at risk. | Brief ("Next brief at 13:00"); Settings, Briefs |
| 2 | **Do not split sequential work.** In one study, agents working alone let errors compound 17.2 times, against 4.4 times with a central coordinator; on sequential tasks every multi-agent setup did 39 to 70% worse than a single agent (Kim et al. 2025). | A manager checks lane output before it moves on. An ask becomes several lanes only where the parts run side by side; steps that build on each other stay in one lane. | Manager page intro; the receipt when an ask is filed |
| 3 | **Who has the information holds the real authority.** Formal authority (the right to decide) and real authority (the information that decides) differ; an approver who knows less than the agent rubber-stamps (Aghion and Tirole 1997). | Decision rights are written down. The owner decides what goes out in their name, what is hard to undo, and what rests on something only they know; agents decide the rest inside the guardrails and report it, with Undo. Every decision says why it is the owner's. | Settings, Who decides; "Yours: …" on each decision; "Why it is yours" on its lane |
| 4 | **A goal needs a counter-metric.** Narrow goals bring tunnel vision, cut corners and distorted risk (Ordóñez et al. 2009). Agents optimise harder than people. | Every goal carries guardrails: what reaching it must not cost (bounces, people asking to stop, unchecked sends, terms). A breached guardrail becomes a blocker under Needs you. For new, unclear work, a learning goal comes before a number. | Topic page, Guardrails line; framework R20 |
| 5 | **A structured handover, read back.** The I-PASS handoff programme cut medical errors by 23% across 9 hospitals (Starmer et al. 2014; before and after, not randomised). Its last step is the receiver saying the situation back. | Every resume, restart, fresh session or change of lead gets a handover: where it stood, what is open, what could go wrong, what to do then. The new session says it back; the hub compares it with the lane's record, and until they match the lane sends nothing outside. | Lane page, Handover; stability layer item 6 |
| 6 | **Need less coordination, or process more of it.** Organisations cope either by reducing what must pass through the top (self-contained units, slack) or by adding reporting and direct links (Galbraith 1974). | Architecture B, a manager per topic, makes topics self-contained. Lane deadlines carry slack, so a small delay does not climb to the manager. The status page is the reporting system. | tmux-architectures.html, B |
| 7 | **Coordination is its own function.** In Beer's Viable System Model, units (System 1) are kept from colliding by a coordination function (System 2), not by management (System 3); an occasional audit (System 3\*) checks what reports say. | Shared things (your mail, the CRM, a repo, the account pool) take turns through the hub, not the manager. The manager spot-checks finished work at random. | Manager page, What lanes share; History (spot checks); stability layer item 7 |
| 8 | **People cannot watch for rare events; trust must match reliability.** Nobody can keep watch on a quiet source for more than about half an hour, so alarms must do it (Bainbridge 1983). Trust should follow what a system has shown, or people misuse or ignore it (Lee and See 2004). | The owner never has to watch terminals; read-only attach is for looking, not supervising. Each agent shows its record: how often its work held when someone else checked it. | Agent cards, Record |
| 9 | **Situation awareness has three levels:** perceive the state, understand it, project what comes next (Endsley 1995). | Confirms the status page's order: state, verdict, forecast. | topic-status-framework.md |
| 10 | **Checklists at pause points.** A 19-item surgical checklist cut deaths after surgery from 1.5% to 0.8% (Haynes et al. 2009). | Before anything goes outside, its lane shows the checks it passed. Done stays a checklist checked by someone other than the lead. | Lane page, "Checked before it goes out" |
| 11 | **Forecasts drift towards optimism** unless anchored in what happened before (planning fallacy, Kahneman and Tversky; reference-class forecasting, Flyvbjerg 2006). | A forecast word comes from a ladder of facts, and every forecast is kept with what happened, so the ladder learns how often Likely signs. | Recovery plan, How a forecast is set; framework R21 |
| 12 | **How agent teams fail:** unclear specifications, agents misaligned with each other, missing or wrong verification (Cemri et al. 2025, about 1,600 traces). | Confirms the lane: the ask in the asker's words, done-means set before work starts, a Done gate. Added: an agent asks instead of guessing when the ask is unclear. | Lanes |

Left out on purpose: the "decision fatigue" finding about parole judges, which has been strongly disputed.

## Sources

- Simon, H. A. (1971). Designing organizations for an information-rich world. In *Computers, Communications, and the Public Interest*.
- Mark, G., Gudith, D., Klocke, U. (2008). [The cost of interrupted work: more speed and stress](https://interruptions.net/literature/Mark-CHI08.pdf). CHI 2008.
- Leroy, S. (2009). [Why is it so hard to do my work? The challenge of attention residue when switching between work tasks](https://econpapers.repec.org/RePEc:eee:jobhdp:v:109:y:2009:i:2:p:168-181). *OBHDP* 109(2).
- Fitz, N., Kushlev, K., Jagannathan, R., Lewis, T., Paliwal, D., Ariely, D. (2019). [Batching smartphone notifications can improve well-being](https://scholars.duke.edu/publication/1402953). *Computers in Human Behavior* 101.
- Kim, Y. et al. (2025). [Towards a science of scaling agent systems](https://arxiv.org/abs/2512.08296). arXiv 2512.08296.
- Cemri, M. et al. (2025). [Why do multi-agent LLM systems fail?](https://arxiv.org/abs/2503.13657) arXiv 2503.13657.
- Aghion, P., Tirole, J. (1997). [Formal and real authority in organizations](https://econpapers.repec.org/RePEc:ucp:jpolec:v:105:y:1997:i:1:p:1-29). *Journal of Political Economy* 105(1).
- Ordóñez, L. D., Schweitzer, M. E., Galinsky, A. D., Bazerman, M. H. (2009). [Goals gone wild](https://www.hks.harvard.edu/publications/goals-gone-wild-systematic-side-effects-overprescribing-goal-setting). *Academy of Management Perspectives* 23(1).
- Starmer, A. J. et al. (2014). Changes in medical errors after implementation of a handoff program. *NEJM* 371.
- Galbraith, J. R. (1974). [Organization design: an information processing view](https://ideas.repec.org/a/inm/orinte/v4y1974i3p28-36.html). *Interfaces* 4(3).
- Beer, S. (1979, 1985). *The Heart of Enterprise*; *Diagnosing the System for Organizations*.
- Bainbridge, L. (1983). Ironies of automation. *Automatica* 19(6).
- Lee, J. D., See, K. A. (2004). [Trust in automation: designing for appropriate reliance](https://pubmed.ncbi.nlm.nih.gov/15151155/). *Human Factors* 46(1).
- Endsley, M. R. (1995). Toward a theory of situation awareness in dynamic systems. *Human Factors* 37(1).
- Haynes, A. B. et al. (2009). A surgical safety checklist to reduce morbidity and mortality in a global population. *NEJM* 360.
- Kahneman, D., Tversky, A. (1979). Intuitive prediction: biases and corrective procedures. *TIMS Studies in Management Science* 12.
- Flyvbjerg, B. (2006). From Nobel Prize to project management: getting risks right. *Project Management Journal* 37(3).
