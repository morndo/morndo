# The user's preferences file

A preference is a person's stated view, such as which vendor they want for long-form writing. It is not a fact, needs no source, and is never shown as one (ADR-0026, K4). It lives with the user, never in this repository (K12):

`~/.config/morndo-knowledge/preferences.yaml`

## Format

```yaml
preferences:
  - id: write-long          # what an SOP step cites: pref:write-long
    holder: principal       # whose view it is
    on: "2026-10-11"        # when they said it, YYYY-MM-DD
    said: Acme models for long-form writing.   # their words, as they said them
    tasks: [draft]          # the kinds of step it speaks to
  - id: search-pass-acme
    holder: principal
    on: "2026-10-11"
    said: Acme for the search pass.
    tasks: [search-pass]
```

`id` is lowercase letters, digits and hyphens, and names one entry: two entries with one id are both left out. `on` is a real date, quoted, so every YAML reader keeps it as text. `holder`, `said` and each task are not blank. The file's shape is `assets/preferences.schema.json`, which an editor can check as you type; Morndo reads the file with parsePreferences, the authority, which holds every rule of the schema and the unique ids a schema can't say, and leaves a broken entry out with a refusal naming its place.

## How it is used

- An SOP instance may cite a preference in a step's `why`: `why: [notes/writing-boards, pref:write-long]`. A shipped template never does, since a preference is one person's. `sop-check --preferences <this file>` refuses a `pref:<id>` the file doesn't hold, and names each entry it left out; without the file it checks the citation's form only and warns that it did.
- It is always shown as the holder's view, with its date: **Acme models for long-form writing. (your preference, 2026-10-11)**, **Acme for the search pass. (your preference, 2026-10-11)**. Never as "Acme writes best", never in a list of facts.
- A preference doesn't route. The step still names a Role and a model class; to run a given vendor, the user puts it in that Role's chain (K9).
- The step's role group and model class select this user's Scorecard cells once auto routing keeps them (ADR-0020); they are shown beside the step and any preference, sorted by entry, never ranked by Knowledge (K9). A template never cites a preference (sop-check refuses it: preference-in-template).
