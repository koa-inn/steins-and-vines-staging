#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Steins & Vines — Supplemental Issues Importer (Round 2 Code Review)
# Adds 8 new findings from the second code review pass.
#
# Prerequisites: gh CLI installed and authenticated (gh auth login)
# Usage: bash import-issues-supplement.sh [--dry-run] [--repo OWNER/REPO]
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="koa-inn/steins-and-vines-staging"
DRY_RUN=false
CSV_FILE="$(dirname "$0")/github-issues-supplement.csv"
DELAY=2

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --repo) REPO="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if ! command -v gh &>/dev/null; then echo "gh CLI not found. Install: brew install gh"; exit 1; fi
if ! gh auth status &>/dev/null; then echo "Not authenticated. Run: gh auth login"; exit 1; fi
if [[ ! -f "$CSV_FILE" ]]; then echo "CSV not found: $CSV_FILE"; exit 1; fi

echo ""
echo "  Steins & Vines — Supplemental Issues (Round 2 Review)"
echo "  Repo: $REPO"
echo ""

# Ensure the new source label exists
LABEL="source:code-review-2"
COLOR="c9b3e6"
if $DRY_RUN; then
    echo "  [dry-run] Would create label: $LABEL"
else
    gh label create "$LABEL" --color "$COLOR" --repo "$REPO" 2>/dev/null && \
        echo "  Created label: $LABEL" || echo "  Label exists: $LABEL"
fi
echo ""

ISSUES_JSON=$(python3 -c "
import csv, sys, json
with open(sys.argv[1], 'r') as f:
    reader = csv.DictReader(f)
    json.dump([dict(r) for r in reader], sys.stdout)
" "$CSV_FILE")

TOTAL=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "  Creating $TOTAL new issues..."
echo ""

CREATED=0
for i in $(seq 0 $((TOTAL - 1))); do
    TITLE=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['title'])")
    LABELS_STR=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['labels'])")
    BODY=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['body'])")

    echo "  [$((i+1))/$TOTAL] $TITLE"

    if $DRY_RUN; then
        echo "           [dry-run] Would create"
    else
        gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" --label "$LABELS_STR" 2>/dev/null && \
            echo "           Created" || echo "           Failed"
        CREATED=$((CREATED + 1))
        [[ $i -lt $((TOTAL - 1)) ]] && sleep "$DELAY"
    fi
    echo ""
done

echo "  Done! $($DRY_RUN && echo "Previewed $TOTAL issues" || echo "Created $CREATED issues")"
