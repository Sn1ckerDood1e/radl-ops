# Agent Teams for Radl Ops

Agent Teams (Opus 4.6) allows multiple Claude Code instances to work in parallel
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

## Team Recipes for Radl

### 1. Sprint Review Team

For reviewing work at the end of a sprint:

```
Create an agent team to review the changes in this sprint. Spawn three reviewers:
- Security reviewer: check all API routes, auth, and input validation
- Code quality reviewer: check patterns, naming, file organization, and TypeScript types
- Test coverage reviewer: verify test coverage, identify untested code paths
Have them each review the diff from main and report findings. Use Sonnet for each.
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

### 5. Parallel Code Review (PR)

For reviewing pull requests:

```
Create an agent team to review PR #[number]. Spawn three reviewers:
- Security implications (auth, input validation, secrets)
- Performance impact (queries, rendering, bundle size)
- Test coverage and correctness
Have them each review and report findings.
```

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
3. **Size tasks appropriately** — 5-6 tasks per teammate is optimal
4. **Use plan approval for risky work** — Require review before implementation
5. **Use delegate mode** — Keeps the lead focused on coordination
6. **Start with research/review** — Lower risk than parallel implementation
7. **Monitor and steer** — Check in on progress, redirect if needed

## Integration with Sprint Workflow

1. Start sprint: `sprint.sh start`
2. Create agent team for the sprint's tasks
3. Lead coordinates, teammates implement
4. Each teammate commits to the feature branch
5. Lead synthesizes and runs final checks
6. Complete sprint: `sprint.sh complete`

## Token Cost Awareness

Agent Teams use significantly more tokens than single sessions:
- Each teammate has its own full context window
- Messaging between agents adds overhead
- Use for tasks where parallel exploration adds real value
- For simple sequential work, stick to single session + sub-agents
