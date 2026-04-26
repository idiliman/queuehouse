# ISSUES

Open GitHub issues are provided at the start of context (fetched via `gh issue list`). Parse them to understand the open issues.

You will work on issues labeled `afk` only, not those labeled `hitl`.

You've also been passed a file containing the last few commits. Review these to understand what work has been done.

If all AFK tasks are complete, output <promise>NO MORE TASKS</promise>.

# TASK SELECTION

Pick the next task. Prioritize tasks in this order:

1. Critical bugfixes
2. Development infrastructure

Getting development infrastructure like tests and types and dev scripts ready is an important precursor to building features.

3. Tracer bullets for new features

Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures that the overall architecture is sound before investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

4. Polish and quick wins
5. Refactors

# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Use /tdd to complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

- `npm run test` to run the tests
- `npm run typecheck` to run the type checker

# COMMIT

Make a git commit. The commit message must:

1. Include key decisions made
2. Include files changed
3. Blockers or notes for next iteration

Prefix the commit subject with `RALPH:` so the loop can find prior iterations.

# THE ISSUE

If the task is complete, close the GitHub issue with a summary comment using `gh issue close <number> --comment "<summary>"`.

If the task is not complete, add a progress note to the issue using `gh issue comment <number> --body "<note>"` describing what was done.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
