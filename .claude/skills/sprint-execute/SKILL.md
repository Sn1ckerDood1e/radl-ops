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

7. Execute waves from the conductor's Execution Plan (Section 3):

   **For SEQUENTIAL waves (1 task or file conflicts):**
   a. Set task to `in_progress` via TaskUpdate
   b. Read all files in the task's `files` array
   c. Implement changes following patterns from spec
      - Trace data flow in BOTH directions (READ + WRITE paths)
      - When adding a Prisma field: Schema -> Migration -> Validation -> API Handler -> Client
   d. Typecheck: `cd /home/hb/radl && npx tsc --noEmit`
   e. Commit: `git add <specific-files> && git commit -m "<type>(<scope>): <title>"`
   f. `mcp__radl-ops__sprint_progress(message: "Done: <title>")`
   g. Set task to `completed` via TaskUpdate

   **For PARALLEL DISPATCH waves (2+ tasks, no file conflicts):**
   a. Create TaskCreate entries for each task in the wave
   b. Copy-paste the agent spawn commands from the conductor's dispatch block
      - Each Task() call uses: subagent_type="general-purpose", run_in_background=true, model="sonnet"
      - Each agent's prompt includes: task description, file ownership list, typecheck command
   c. While agents work: monitor via TaskOutput (non-blocking)
   d. After ALL agents complete:
      - Read each agent's result
      - Run `npm run typecheck` — agents can't catch cross-cutting issues
      - Fix type errors (leader handles integration)
      - Commit per-task with conventional commits
      - Call `sprint_progress` for each completed task
      - Set tasks to `completed`
   e. If any agent failed: handle as sequential fallback for that task

   **For REVIEW CHECKPOINT waves:**
   - Copy-paste the review agent spawn commands from the conductor's dispatch block
   - Continue to next wave unless CRITICAL/HIGH findings
   - Fix HIGH+ before proceeding

   **For SEQUENTIAL WITH WARNING waves (file conflicts):**
   - Execute tasks one-by-one (same as SEQUENTIAL)
   - DO NOT parallelize — files overlap

8. After all waves: proceed to Phase 4 (Quality Gate)

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

13. Complete sprint with team tracking (auto-extracts compound learnings):
    ```
    mcp__radl-ops__sprint_complete(
      commit: "$(git rev-parse --short HEAD)",
      actual_time: "<actual time>",
      team_used: {
        recipe: "sprint-implementation",
        teammateCount: <agents spawned across all parallel waves>,
        model: "sonnet",
        duration: "<total wall clock for parallel waves>",
        tasksCompleted: <tasks completed by agents>,
        outcome: "success" if all passed typecheck, "partial" if some needed leader fix
      }
    )
    ```
    Omit `team_used` if no parallel waves were executed (all sequential).

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
