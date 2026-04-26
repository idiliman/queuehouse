#!/bin/bash

set -e

issues=$(gh issue list --state open --label afk --json number,title,body,labels,url --limit 50 2>/dev/null || echo "[]")

ralph_commits=$(git log --grep="RALPH" -n 10 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No RALPH commits found")

cursor-agent --print --force "@ralph/prompt.md

Open GitHub issues (label: afk):
$issues

Previous RALPH commits:
$ralph_commits"
