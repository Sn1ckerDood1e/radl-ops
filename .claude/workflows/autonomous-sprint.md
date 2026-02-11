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

### Task Parallelization

Before starting execution, check the task dependency graph:
- **Independent tasks** (no shared files, no data dependencies) → consider spawning
  a team with Sonnet teammates, each owning one task
- **Dependent tasks** (later task reads earlier task's output) → execute sequentially
- **Rule of thumb:** If 3+ tasks are independent, use a team. If <3, serial is fine.

### For each task:

1. **Update task status** - Set to `in_progress`
2. **Research before implementing** — If the task involves an external API or library
   you haven't used before, query context7 first:
   ```
   mcp__context7__resolve-library-id → mcp__context7__query-docs
   ```
   This prevents writing code that misuses APIs (e.g., loading all users when you need one).
3. **Execute the work** - Write code, run tests
4. **Trace the full data flow** — When adding data to a list/page, verify ALL layers connect:
   - Server component → Prisma query (includes the new fields?)
   - Server component → client props mapping (passes the new fields?)
   - Client component → child component props (forwards the new fields?)
   - Child component → render (displays the new fields?)
   Don't just update the API endpoint and client independently. If the server page
   maps props explicitly, new fields will be silently dropped.
5. **Typecheck after changes**: `npm run typecheck`
6. **Commit per task** (never batch all tasks into one commit):
   ```bash
   git add <specific-files> && git commit -m "feat(<scope>): description"
   ```
   Per-task commits enable targeted reverts. One monolith commit for an entire sprint
   makes it impossible to roll back a single task without losing the others.
7. **Record progress** (use MCP tool):
   ```
   mcp__radl-ops__sprint_progress(message: "Done: task description")
   ```
8. **Mid-sprint review gate** — If this task introduced a NEW pattern (new helper,
   new data access approach, new API integration), run a background incremental review:
   ```
   Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",
        prompt="Review [files] for pattern correctness, API misuse, missing guards")
   Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",
        prompt="Spot-check [files] for auth bypass, data leaks, injection")
   ```
   Fix HIGH issues before they propagate to the next task.
9. **Update task status** to `completed`

## Checkpoint Protocol

Every 30-45 minutes or after completing 2-3 tasks:
```bash
/home/hb/radl-ops/scripts/sprint.sh checkpoint
```

If context window is filling up (>75%), use `/strategic-compact` skill.

## Code Review (Mandatory — BOTH reviewers)

After completing all tasks, before creating PR:
1. Run **code-reviewer** AND **security-reviewer** agents in parallel (both `run_in_background: true`):
   ```
   Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",
        prompt="Review git diff main...HEAD for [scope]")
   Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",
        prompt="Security review git diff main...HEAD for [scope]")
   ```
   **Never skip the security reviewer** — especially for auth changes, tier enforcement,
   API boundary changes, or user input handling. In Phase 60, skipping it missed that
   the tier check could receive legacy enum values.
2. Fix any CRITICAL or HIGH issues
3. Run final typecheck: `npm run typecheck`

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
