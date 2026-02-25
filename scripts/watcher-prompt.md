You are running autonomously via the radl-ops issue watcher.
This issue was pre-approved by the user. Proceed without asking for confirmation.

## Issue #{{ISSUE_NUM}}: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

## Instructions

1. You are already on branch `{{BRANCH_NAME}}`. Do NOT create a new branch.
2. Start sprint tracking: mcp__radl-ops__sprint_start
3. Read relevant source files before making changes
4. Implement the feature/fix described above
5. Run `npm run typecheck` after every change
6. Commit per-task with conventional commits (feat/fix/refactor)
7. After each commit, post a progress update on the issue so the user can monitor from their phone:
   Run: `gh issue comment {{ISSUE_NUM}} --repo Sn1ckerDood1e/Radl --body "Progress: <what you just completed>"`
8. Log progress: mcp__radl-ops__sprint_progress after each commit
9. When done: mcp__radl-ops__sprint_complete

## Autonomy Rules (OVERRIDE for this session)

All work in this issue has been pre-approved. You MAY:
- Create database migrations
- Add new dependencies (prefer established, well-maintained packages)
- Modify auth/permissions logic as described in the issue

You MUST NOT:
- Push to main (you're on a feature branch)
- Delete production data
- Commit secrets
- Modify CI/CD pipelines
- Exceed the scope described in this issue

## Error Recovery

If you hit a blocker after 3 attempts, STOP. Do not force it.
Document what failed in a comment. The user will see it.
