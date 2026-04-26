#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

issues=$(gh issue list --state open --label afk --json number,title,body,labels,url --limit 50 2>/dev/null || echo "[]")

ralph_commits=$(git log --grep="RALPH" -n 10 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No RALPH commits found")

prompt_body="@${REPO_ROOT}/ralph/prompt.md

Open GitHub issues (label: afk):
$issues

Previous RALPH commits:
$ralph_commits"

# Default to interactive mode. Use headless mode for scripts/CI.
if [[ "${RALPH_HEADLESS:-}" == 1 ]] || [[ "${1:-}" == "--headless" ]]; then
  cursor-agent --print --force --trust --workspace "$REPO_ROOT" "$prompt_body"
else
  cursor-agent --force --workspace "$REPO_ROOT" "$prompt_body"
fi
