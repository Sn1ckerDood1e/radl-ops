# Autonomous Sprint Workflow

When the user says "run autonomous sprint" or similar, follow this workflow.

## Pre-Sprint Checklist

1. **Create feature branch** from main:
   ```bash
   cd /home/hb/radl && git checkout main && git pull origin main
   git checkout -b feat/<phase-slug>
   ```
   NEVER work directly on main.

2. **Start sprint tracking**:
   ```bash
   /home/hb/radl-ops/scripts/sprint.sh start "Phase X" "Title" "estimate"
   ```

3. **Create tasks** using TaskCreate tool:
   - Max 5-7 tasks per sprint
   - Each task should be completable in 30-60 minutes
   - Include clear acceptance criteria

4. **Set dependencies** using TaskUpdate:
   - Chain tasks that depend on each other
   - Allow parallel execution where possible

## Execution Phase

For each task:

1. **Update task status** - Set to `in_progress`
2. **Record sprint progress**:
   ```bash
   /home/hb/radl-ops/scripts/sprint.sh progress "Starting: task description"
   ```
3. **Execute the work** - Write code, run tests
4. **Typecheck after changes**: `npm run typecheck`
5. **Commit to feature branch** (never to main):
   ```bash
   git add <specific-files> && git commit -m "feat(<scope>): description"
   ```
6. **Update task status** to `completed`
7. **Record progress**:
   ```bash
   /home/hb/radl-ops/scripts/sprint.sh progress "Done: task description"
   ```

## Checkpoint Protocol

Every 30-45 minutes or after completing 2-3 tasks:
```bash
/home/hb/radl-ops/scripts/sprint.sh checkpoint
```

If context window is filling up (>75%), use `/strategic-compact` skill.

## Code Review (Mandatory)

After completing all tasks, before creating PR:
1. Run **code-reviewer** agent on all changed files
2. Run **security-reviewer** agent if auth/API changes were made
3. Fix any CRITICAL or HIGH issues
4. Run final typecheck: `npm run typecheck`

## Completion

1. **Final checks**:
   ```bash
   cd /home/hb/radl
   npm run typecheck
   npm run lint
   ```

2. **Complete sprint**:
   ```bash
   COMMIT=$(git rev-parse --short HEAD)
   /home/hb/radl-ops/scripts/sprint.sh complete "$COMMIT" "actual_time"
   ```

3. **Extract learnings**:
   ```bash
   /home/hb/radl-ops/scripts/compound.sh extract
   ```

4. **Push and create PR** (not direct to main):
   ```bash
   git push -u origin feat/<phase-slug>
   gh pr create --title "feat: description" --body "..."
   ```

5. **Update STATE.md** with sprint results

## Error Recovery

If a task fails:
1. Record blocker: `sprint.sh blocker "description"`
2. Attempt one retry with adjusted approach
3. If still failing after 3 attempts, STOP and escalate to user (3-strike rule)
4. Document in sprint checkpoint

## Branch Naming Convention

- Features: `feat/<phase-or-feature>`
- Bug fixes: `fix/<description>`
- Refactors: `refactor/<description>`
- Ops improvements: `ops/<description>`
