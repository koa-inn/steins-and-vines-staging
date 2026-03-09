#!/usr/bin/env bash
# run-docs-validation.sh — Run the weekly docs validation task
#
# Usage:
#   ./scripts/run-docs-validation.sh              # runs the validation
#   crontab -e  # then add:  0 6 * * 1 /path/to/steins-and-vines-website/scripts/run-docs-validation.sh
#
# Prerequisites:
#   - Claude Code CLI (`claude`) installed and authenticated
#   - Run from the project root directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

PROMPT_FILE="$SCRIPT_DIR/weekly-docs-validation-prompt.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: Prompt file not found at $PROMPT_FILE"
  exit 1
fi

# Strip the YAML frontmatter, pass the rest as the prompt
PROMPT=$(sed '1{/^---$/!q;};1,/^---$/d' "$PROMPT_FILE")

echo "Starting docs validation at $(date)..."
echo "Project directory: $PROJECT_DIR"
echo ""

# Run Claude with the prompt in non-interactive mode
claude -p "$PROMPT" --allowedTools "Read,Write,Edit,Bash,Glob,Grep"

echo ""
echo "Validation complete at $(date)."
echo "Check docs-validation-report.md for results."
