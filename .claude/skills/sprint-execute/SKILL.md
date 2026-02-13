# /sprint-execute — Autonomous Sprint Execution

One command. Full autonomous sprint. Human approves the spec, everything else is automated.

## Usage

```
/sprint-execute "Add practice attendance tracking"
/sprint-execute "Refactor auth middleware to use CASL"
/sprint-execute "Add bulk athlete import via CSV"
```

## Arguments

The argument is a feature description (required). Can be a short title or a detailed description with context.

## Workflow

### Phase 1: Research & Spec (AI-Powered)

1. Call `mcp__radl-ops__sprint_conductor` with the feature description:
   ```
   sprint_conductor({
     feature: "<user's feature description>",
     quality_threshold: 8,
     parallel: true,
   })
   ```

2. Present the quality-scored spec to the user:
   ```
   ## Sprint Spec (Quality: X/10)

   <spec content from conductor>

   ## Proposed Tasks

   <task table from conductor>

   ## Execution Plan

   <parallel waves + team recommendation>

   **Approve, modify, or reject?**
   ```

3. Wait for user approval using AskUserQuestion:
   - "Approve and execute" — proceed to Phase 2
   - "Modify" — let user adjust, then re-present
   - "Reject" — stop

### Phase 2: Setup

4. Create feature branch from main:
   ```bash
   cd /home/hb/radl && git checkout main && git pull origin main
   git checkout -b feat/<phase-slug>
   ```

5. Start sprint tracking:
   ```
   mcp__radl-ops__sprint_start(phase: "<phase>", title: "<title>", estimate: "<calibrated estimate>", task_count: <N>)
   ```

6. Create all tasks from conductor output using TaskCreate:
   - Use the `subject`, `description`, and `activeForm` from each task
   - Set dependencies with TaskUpdate `addBlockedBy`

### Phase 3: Execution

7. For each task (respecting dependency order):

   a. Set task to `in_progress` via TaskUpdate

   b. Read all files listed in the task's `files` array

   c. Implement the changes:
      - Follow ALL patterns from the conductor spec
      - Trace data flow in BOTH directions (READ + WRITE paths)
      - When adding a Prisma field: Schema -> Migration -> Validation -> API Handler -> Client

   d. Run typecheck: `cd /home/hb/radl && npx tsc --noEmit`

   e. Commit per-task with conventional commit format:
      ```bash
      git add <specific-files>
      git commit -m "<type>(<scope>): <description>"
      ```

   f. Record progress: `mcp__radl-ops__sprint_progress(message: "Done: <task title>")`

   g. If this task introduces a NEW pattern, spawn background reviewers:
      ```
      Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",
           prompt="Review <changed files> for pattern correctness")
      Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",
           prompt="Spot-check <changed files> for auth bypass, injection")
      ```

   h. Set task to `completed` via TaskUpdate

8. If 3+ tasks are independent (same wave in execution plan):
   - Use lightweight parallel: `Task(run_in_background=true)` for each
   - Each agent owns its files exclusively (no overlap)
   - Leader handles shared files after all agents complete

### Phase 4: Quality Gate

9. Run final checks:
   ```bash
   cd /home/hb/radl && npx tsc --noEmit
   ```

10. Spawn parallel reviewers (BOTH required):
    ```
    Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",
         prompt="Review git diff main...HEAD for <scope>")
    Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",
         prompt="Security review git diff main...HEAD for <scope>")
    ```

11. Fix any CRITICAL or HIGH findings from reviewers

12. Run pre-flight check:
    ```
    mcp__radl-ops__pre_flight_check()
    ```

### Phase 5: Ship & Learn

13. Complete sprint (auto-extracts compound learnings):
    ```
    mcp__radl-ops__sprint_complete(
      commit: "$(git rev-parse --short HEAD)",
      actual_time: "<actual time>"
    )
    ```

14. Push and create PR:
    ```bash
    git push -u origin feat/<phase-slug>
    gh pr create --title "<type>: <description>" --body "<PR template from conductor>"
    ```

15. Update STATE.md with sprint results

## Decision Points

- **Schema changes detected in spec?** Always make migration task #1
- **3+ independent tasks?** Use parallel execution with background agents
- **Auth/permissions changes?** ALWAYS run security-reviewer (never skip)
- **External API integration?** Research with context7 BEFORE implementation
- **Build fails after a task?** Fix immediately, don't continue to next task

## Iron Laws (NEVER violate)

1. Never push to main — feature branches + PRs only
2. Never commit secrets
3. After 3 failures on same issue — STOP and escalate to user
4. Never skip security review for auth changes
5. Commit per-task, never batch entire sprint into one commit

## Estimation Calibration

Historical data shows actual time runs ~50% of estimated:
- Apply 0.5x multiplier to all estimates
- A "3 hour" sprint typically takes 1.5 hours
