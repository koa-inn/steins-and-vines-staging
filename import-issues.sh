#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Steins & Vines — GitHub Issues Importer
# Reads github-issues.csv and creates issues via `gh` CLI.
#
# Prerequisites:
#   1. Install gh CLI: brew install gh
#   2. Authenticate:   gh auth login
#   3. Run this script: bash import-issues.sh
#
# Options:
#   --dry-run    Preview issues without creating them
#   --repo OWNER/REPO   Override target repo (default: koa-inn/steins-and-vines-staging)
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="koa-inn/steins-and-vines-staging"
DRY_RUN=false
CSV_FILE="$(dirname "$0")/github-issues.csv"
DELAY=2  # seconds between API calls to avoid rate limiting

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --repo) REPO="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Check prerequisites
if ! command -v gh &>/dev/null; then
    echo "❌ gh CLI not found. Install with: brew install gh"
    exit 1
fi

if ! gh auth status &>/dev/null; then
    echo "❌ Not authenticated. Run: gh auth login"
    exit 1
fi

if [[ ! -f "$CSV_FILE" ]]; then
    echo "❌ CSV file not found: $CSV_FILE"
    exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  Steins & Vines — GitHub Issues Importer"
echo "  Repo: $REPO"
echo "  Mode: $($DRY_RUN && echo 'DRY RUN (no issues created)' || echo 'LIVE')"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Step 1: Create labels if they don't exist ──────────────────
echo "📋 Ensuring labels exist..."

LABEL_DEFS=(
    "priority:critical:d73a4a"
    "priority:high:e36209"
    "priority:medium:fbca04"
    "priority:low:0e8a16"
    "type:security:b60205"
    "type:bug:d73a4a"
    "type:performance:5319e7"
    "type:accessibility:1d76db"
    "type:ux:c5def5"
    "type:testing:bfdadc"
    "type:infra:d4c5f9"
    "type:cleanup:fef2c0"
    "type:feature:a2eeef"
    "source:code-review:e6e6e6"
    "source:backlog:e6e6e6"
    "source:gemini-review:e6e6e6"
    "source:testing-backlog:e6e6e6"
    "source:kiosk-setup:e6e6e6"
)

for entry in "${LABEL_DEFS[@]}"; do
    label="${entry%:*}"
    color="${entry##*:}"
    if $DRY_RUN; then
        echo "  [dry-run] Would create label: $label (#$color)"
    else
        gh label create "$label" --color "$color" --repo "$REPO" 2>/dev/null && \
            echo "  Created: $label" || \
            echo "  Exists:  $label"
    fi
done

echo ""

# ── Step 2: Parse CSV and create issues ────────────────────────
echo "🎫 Creating issues..."
echo ""

CREATED=0
FAILED=0
SKIPPED=0

# Read CSV, skip header line
# CSV format: title,labels,body
# Fields are quoted with double quotes; body may contain newlines

parse_csv() {
    python3 -c "
import csv, sys, json

with open(sys.argv[1], 'r') as f:
    reader = csv.DictReader(f)
    issues = []
    for row in reader:
        issues.append({
            'title': row['title'],
            'labels': row['labels'],
            'body': row['body']
        })
    json.dump(issues, sys.stdout)
" "$1"
}

ISSUES_JSON=$(parse_csv "$CSV_FILE")
TOTAL=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")

echo "  Found $TOTAL issues to create"
echo ""

for i in $(seq 0 $((TOTAL - 1))); do
    TITLE=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['title'])")
    LABELS_STR=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['labels'])")
    BODY=$(echo "$ISSUES_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['body'])")

    NUM=$((i + 1))
    echo "  [$NUM/$TOTAL] $TITLE"

    if $DRY_RUN; then
        echo "           Labels: $LABELS_STR"
        echo "           [dry-run] Would create issue"
        echo ""
        SKIPPED=$((SKIPPED + 1))
    else
        if gh issue create \
            --repo "$REPO" \
            --title "$TITLE" \
            --body "$BODY" \
            --label "$LABELS_STR" \
            2>/dev/null; then
            CREATED=$((CREATED + 1))
            echo "           ✅ Created"
        else
            FAILED=$((FAILED + 1))
            echo "           ❌ Failed"
        fi
        # Rate limit protection
        if [[ $i -lt $((TOTAL - 1)) ]]; then
            sleep "$DELAY"
        fi
        echo ""
    fi
done

# ── Summary ────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════"
echo "  Done!"
if $DRY_RUN; then
    echo "  Previewed: $SKIPPED issues (dry run — nothing created)"
else
    echo "  Created: $CREATED | Failed: $FAILED"
fi
echo "═══════════════════════════════════════════════════════"
