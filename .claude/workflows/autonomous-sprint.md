# Autonomous Sprint Workflow

When the user says "run autonomous sprint" or similar, follow this workflow.

## Setup Phase

1. **Create STATUS.md** at `/home/hb/radl-ops/STATUS.md`:
```markdown
# Radl Ops Work Status

**Started:** [timestamp]
**Last Updated:** [timestamp]

## Current Task
Setting up task queue...

## Task Queue
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | [task] | PENDING | [notes] |

## Completed Work
(None yet)

## Errors / Blockers
(None yet)

## Commits
(None yet)
```

2. **Create tasks** using TaskCreate tool:
   - Max 5-7 tasks per sprint
   - Each task should be completable in 30-60 minutes
   - Include clear acceptance criteria

3. **Set dependencies** using TaskUpdate:
   - Chain tasks that depend on each other
   - Allow parallel execution where possible

## Execution Phase

For each task:

1. **Update STATUS.md** - Mark task IN PROGRESS
2. **Update task status** - Set to `in_progress`
3. **Spawn background agent** using Task tool with `run_in_background: true`
4. **Wait for completion** - Agent will notify when done
5. **On completion:**
   - Update task status to `completed`
   - Update STATUS.md with summary
   - Start next task in queue

## Agent Prompt Template

```
You are working on the Radl codebase at /home/hb/radl.

**Task:** [description]

**Requirements:**
[detailed requirements]

**After completing:**
1. Run `npm run typecheck` to verify no type errors
2. Run `npm run build` to verify build passes
3. Commit with: `git add -A && git commit -m "[message]"`
4. Push with: `git push origin main`

Report what you built and any issues encountered.
```

## Error Recovery

If a task fails:
1. Note error in STATUS.md under "Errors / Blockers"
2. Attempt one retry with adjusted approach
3. If still failing, pause and document for user review

## Completion

When all tasks done:
1. Update STATUS.md with final summary
2. Run polish pass (typecheck, build, lint)
3. Check Vercel deployment status
4. Notify user via STATUS.md

## User Notification

Update STATUS.md after every task completion. User can check this file anytime to see progress.

If notification webhook is configured (NOTIFICATION_WEBHOOK in .env), send completion ping:
```bash
curl -X POST "$NOTIFICATION_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d '{"content": "[status message]"}'
```
