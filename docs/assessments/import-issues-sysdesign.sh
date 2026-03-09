#!/usr/bin/env bash
# import-issues-sysdesign.sh — Import system-design assessment tickets into GitHub Issues
# Usage: ./import-issues-sysdesign.sh [--dry-run] [--repo owner/repo]

set -euo pipefail

DRY_RUN=false
REPO=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --repo) REPO="--repo $2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Create labels (idempotent — gh ignores duplicates) ──
declare -A LABELS=(
  ["priority:critical"]="d73a4a"
  ["priority:high"]="ff6600"
  ["priority:medium"]="fbca04"
  ["priority:low"]="0e8a16"
  ["area:payments"]="5319e7"
  ["area:infrastructure"]="006b75"
  ["area:security"]="b60205"
  ["area:reliability"]="1d76db"
  ["area:feature"]="0075ca"
  ["source:system-design"]="c5def5"
)

echo "Creating labels..."
for label in "${!LABELS[@]}"; do
  color=${LABELS[$label]}
  if $DRY_RUN; then
    echo "  [dry-run] gh label create \"$label\" --color $color $REPO"
  else
    gh label create "$label" --color "$color" --force $REPO 2>/dev/null || true
  fi
done
echo ""

# ── Import issues from CSV ──
echo "Importing issues..."
python3 -c "
import csv, subprocess, sys

dry_run = '--dry-run' in sys.argv
repo_args = []
if '--repo' in sys.argv:
    idx = sys.argv.index('--repo')
    repo_args = ['--repo', sys.argv[idx + 1]]

with open('github-issues-sysdesign.csv', newline='') as f:
    reader = csv.DictReader(f)
    for i, row in enumerate(reader, 1):
        title = row['title'].strip()
        body  = row['body'].strip().replace('\\\\n', '\n')
        labels = [l.strip() for l in row['labels'].split(',') if l.strip()]
        label_args = []
        for l in labels:
            label_args += ['--label', l]

        cmd = ['gh', 'issue', 'create', '--title', title, '--body', body] + label_args + repo_args
        if dry_run:
            print(f'  [{i}] {title}')
            print(f'       labels: {\", \".join(labels)}')
        else:
            print(f'  [{i}] Creating: {title}')
            subprocess.run(cmd, check=True)
            print(f'       Done.')
        print()
" "$@"

echo "Complete."
