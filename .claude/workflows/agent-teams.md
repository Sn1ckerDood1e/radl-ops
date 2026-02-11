# Agent Teams for Radl Ops

Agent Teams allows multiple Claude Code instances to work in parallel
with shared task lists and inter-agent messaging.

## How It Works

- **Team Lead**: Main Claude session that coordinates work
- **Teammates**: Independent Claude instances with their own context windows
- **Shared Task List**: Central work queue with dependency tracking
- **Mailbox**: Inter-agent messaging for coordination

Unlike sub-agents (Task tool), teammates are full independent sessions that can
communicate with each other, not just report back to the caller.

## When to Use Agent Teams vs Sub-Agents

| Scenario | Use |
|----------|-----|
| Quick file search / focused task | Sub-agent (Task tool) |
| Parallel code review (security + quality + perf) | Agent Team |
| Single feature implementation | Single session |
| Multi-module feature with tests | Agent Team |
| Research competing approaches | Agent Team |
| Debugging with multiple hypotheses | Agent Team |
| Simple bug fix | Single session |

## MCP Tool: `team_recipe`

Recipes are available programmatically via `mcp__radl-ops__team_recipe`. Pass a recipe type
(`review`, `feature`, `debug`, `research`) and optional `context`, `files`, and `model` params.
Returns structured JSON with teammates, setup steps, cleanup steps, and tips.

## Validated Team Recipes

### 1. Parallel Codebase Review (TESTED Feb 9, 2026)

Spawns 3 reviewers in parallel. Each reviews the full codebase from a different
angle. Lead can fix issues while reviewers work.

**Practical steps:**
1. `TeamCreate` with a descriptive name (e.g., `ops-review`)
2. Create task per reviewer in team task list
3. Spawn 3 teammates using `Task` tool with `team_name` and `run_in_background: true`
4. Work on other things while reviewers run (~5-8 min for small codebases)
5. Read findings from team messages as they arrive
6. Fix HIGH/CRITICAL issues immediately
7. `SendMessage` shutdown requests to all teammates
8. `TeamDelete` to clean up

**Agent types to use:**
- `security-reviewer` — OWASP, secrets, injection, auth
- `code-reviewer` — dead code, types, naming, test gaps
- `architect` — module organization, coupling, extensibility

**Model:** Sonnet for all reviewers (good balance of quality and cost)

**Findings format:** CRITICAL / HIGH / MEDIUM / LOW with file:line references

```
TeamCreate: "my-review"
TaskCreate x3 (one per reviewer)
Task(subagent_type="security-reviewer", team_name="my-review", run_in_background=true)
Task(subagent_type="code-reviewer", team_name="my-review", run_in_background=true)
Task(subagent_type="architect", team_name="my-review", run_in_background=true)
# ... fix issues while waiting ...
SendMessage(shutdown_request) x3
TeamDelete
```

### 2. Feature Implementation Team

For building a multi-part feature:

```
Create an agent team to implement [feature]. Spawn teammates:
- Backend engineer: API routes, database queries, validation schemas
- Frontend engineer: React components, client-side state, UI/UX
- Test engineer: Unit tests, integration tests, E2E tests
Require plan approval before they make any changes.
Use delegate mode so I coordinate, teammates implement.
```

### 3. Bug Investigation Team

For debugging complex issues:

```
Create an agent team to investigate [bug description]. Spawn 3 teammates,
each investigating a different hypothesis:
- Teammate 1: Check if it's a data/state issue
- Teammate 2: Check if it's a timing/race condition
- Teammate 3: Check if it's an API/network issue
Have them talk to each other to try to disprove each other's theories.
```

### 4. Research Team

For evaluating approaches before implementation:

```
Create an agent team to research [topic]. Spawn teammates:
- Library researcher: evaluate existing packages and tools
- Architecture analyst: design system integration approach
- Risk assessor: identify pitfalls, performance concerns, security issues
Have them share findings and produce a recommendation.
```

### 5. Incremental Review (Mid-Sprint Spot-Check)

Lightweight alternative to a full review team. Uses 2 background sub-agents (not a full
agent team) to catch bugs between tasks before they propagate.

**When to use:** After completing a task that introduces a NEW pattern (new API helper,
new data access approach, new integration). Skip for tasks following existing patterns.

```
# After committing a task with new patterns:
Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",
     prompt="Review [changed files] for pattern correctness, API misuse, missing guards")
Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",
     prompt="Spot-check [changed files] for auth bypass, data leaks, injection")
# Continue to next task while they run (~2-3 min)
# Fix HIGH issues before starting subsequent tasks
```

**Why this matters:** In Phase 59, a `listUsers()` bug was introduced in Task 2
and copied into Task 3 before review caught it. An incremental review after Task 2
would have caught it before Task 3 replicated the pattern.

Also available via MCP: `team_recipe(recipe: "incremental-review", context: "...", files: "...")`

## Lessons Learned (Feb 11, 2026 — updated)

1. **Task list context switches** — When you create a team, task operations target
   the team's task list. After `TeamDelete`, context returns to the main list.
   Be aware of which task list you're operating on.

2. **run_in_background is essential** — Without it, spawning 3 teammates blocks
   the lead. With `run_in_background: true`, the lead can do other work while
   teammates run.

3. **Sonnet is sufficient for reviews** — No need for Opus on review tasks.
   Sonnet finds the same issues at lower cost.

4. **Teammates complete fast** — A full codebase review (~20 files) takes 3-5 min
   per reviewer. Don't over-estimate the wait time.

5. **Fix issues while waiting** — The best workflow is: spawn reviewers, then
   start fixing known issues. When reviewer messages arrive, triage and fix
   the new findings.

6. **Shutdown explicitly** — Always send shutdown requests before TeamDelete.
   Teammates don't auto-terminate when their task completes.

7. **Reviews work best, implementation needs more testing** — Parallel review is
   the proven use case. Parallel implementation carries risk of file conflicts.

8. **Use teams for sprint tasks when 3+ are independent** — In Phase 60, 4 of 6
   tasks had no dependencies. Serializing them added ~15 min of wall time that
   parallelization would have eliminated. When a plan identifies independent tasks,
   that's the signal to spawn teammates.

9. **Always run BOTH code + security reviewers** — In Phase 60, only running
   code-reviewer missed that the tier check could receive legacy enum values.
   Security-reviewer catches auth/boundary issues that code-reviewer doesn't focus on.

## Display Mode

Default: `auto` (uses split panes if in tmux, otherwise in-process)

Controls:
- **Shift+Up/Down**: Select teammate (in-process mode)
- **Enter**: View teammate's full session
- **Escape**: Interrupt current turn
- **Ctrl+T**: Toggle task list
- **Shift+Tab**: Toggle delegate mode (lead coordinates only)

## Best Practices

1. **Give teammates enough context** — They get CLAUDE.md but not conversation history
2. **Avoid file conflicts** — Each teammate should own different files
3. **Size tasks appropriately** — 1 focused task per teammate for reviews
4. **Use plan approval for risky work** — Require review before implementation
5. **Start with research/review** — Lower risk than parallel implementation
6. **Use background mode** — Always `run_in_background: true` for teammates

## Integration with Sprint Workflow

1. Start sprint: `sprint_start`
2. Create agent team for review tasks
3. Lead implements while reviewers work
4. Triage and fix reviewer findings
5. Shutdown team, delete
6. Complete sprint: `sprint_complete`

## Token Cost Awareness

Agent Teams use significantly more tokens than single sessions:
- Each teammate has its own full context window
- Messaging between agents adds overhead
- Use for tasks where parallel exploration adds real value
- For simple sequential work, stick to single session + sub-agents
- Sonnet teammates are ~3x cheaper than Opus teammates
