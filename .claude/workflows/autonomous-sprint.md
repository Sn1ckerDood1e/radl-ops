# Autonomous Sprint Workflow

When the user says "run autonomous sprint" or similar, follow this workflow.

## Pre-Sprint Checklist

1. **Create feature branch** from main:
   ```bash
   cd /home/hb/radl && git checkout main && git pull origin main
   git checkout -b feat/<phase-slug>
   ```
   NEVER work directly on main.

2. **Start sprint tracking** (use MCP tool, not shell script):
   ```
   mcp__radl-ops__sprint_start(phase: "Phase X", title: "Title", estimate: "3 hours")
   ```

3. **Parallel context loading** — Read key files simultaneously at sprint start:
   - STATE.md for current progress
   - Relevant source files for the sprint scope
   - Any related test files
   - Use parallel Read tool calls, not sequential

4. **Create tasks** using TaskCreate tool:
   - Max 5-7 tasks per sprint
   - Each task should be completable in 30-60 minutes
   - Include clear acceptance criteria

5. **Set dependencies** using TaskUpdate:
   - Chain tasks that depend on each other
   - Allow parallel execution where possible

## Execution Phase

For each task:

1. **Update task status** - Set to `in_progress`
2. **Research before implementing** — If the task involves an external API or library
   you haven't used before, query context7 first:
   ```
   mcp__context7__resolve-library-id → mcp__context7__query-docs
   ```
   This prevents writing code that misuses APIs (e.g., loading all users when you need one).
3. **Execute the work** - Write code, run tests
4. **Typecheck after changes**: `npm run typecheck`
5. **Commit to feature branch** (never to main):
   ```bash
   git add <specific-files> && git commit -m "feat(<scope>): description"
   ```
6. **Record progress** (use MCP tool):
   ```
   mcp__radl-ops__sprint_progress(message: "Done: task description")
   ```
7. **Mid-sprint review gate** — If this task introduced a NEW pattern (new helper,
   new data access approach, new API integration), run a background incremental review:
   ```
   Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",
        prompt="Review [files] for pattern correctness, API misuse, missing guards")
   Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",
        prompt="Spot-check [files] for auth bypass, data leaks, injection")
   ```
   Fix HIGH issues before they propagate to the next task.
8. **Update task status** to `completed`

## Checkpoint Protocol

Every 30-45 minutes or after completing 2-3 tasks:
```bash
/home/hb/radl-ops/scripts/sprint.sh checkpoint
```

If context window is filling up (>75%), use `/strategic-compact` skill.

## Code Review (Mandatory)

After completing all tasks, before creating PR:
1. Run **code-reviewer** agent on all changed files (parallel with security)
2. Run **security-reviewer** agent on all changed files (parallel with code)
3. Fix any CRITICAL or HIGH issues
4. Run final typecheck: `npm run typecheck`

## Completion

1. **Final checks**:
   ```bash
   cd /home/hb/radl
   npm run typecheck
   npm run lint
   ```

2. **Complete sprint** (use MCP tool):
   ```
   COMMIT=$(git rev-parse --short HEAD)
   mcp__radl-ops__sprint_complete(commit: "$COMMIT", actual_time: "1.5 hours")
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
