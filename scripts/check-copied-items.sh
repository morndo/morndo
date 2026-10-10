#!/usr/bin/env bash
# Privacy check (code review of the readability pass, #14): which lines this branch adds share wording with the
# a needs-you list? Fixtures and comments must use invented items.
# It reads the list at run time and prints only file:line and how many four-word phrases match: never the words.
# A hit is for a person to judge.
# Usage: scripts/check-copied-items.sh [base] [list]   (defaults: origin/main, $MORNDO_LEDGER)
set -euo pipefail
base="${1:-origin/main}"
list="${2:-${MORNDO_LEDGER:-}}"
if [ -z "$list" ] || [ ! -r "$list" ]; then echo "SKIP: no needs-you list"; exit 0; fi
git diff -U0 "$base" -- '*.ts' '*.svelte' '*.md' | LIST="$list" python3 -c '
import sys, re, os
led = open(os.environ["LIST"], encoding="utf-8").read().lower()
cur = None; ln = 0
for l in sys.stdin:
    if l.startswith("+++ "): cur = l[6:].strip(); continue
    m = re.match(r"^@@ -\S+ \+(\d+)", l)
    if m: ln = int(m.group(1)); continue
    if l.startswith("+"):
        w = l[1:].split()
        n = sum(1 for i in range(len(w) - 3) if len(" ".join(w[i:i + 4])) >= 18 and " ".join(w[i:i + 4]).lower().strip("\"\x27,;") in led)
        if n >= 2: print(f"{cur}:{ln} {n}")
        ln += 1'
