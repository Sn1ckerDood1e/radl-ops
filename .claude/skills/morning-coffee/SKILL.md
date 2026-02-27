# /morning-coffee — Morning Planning Session

Full morning planning workflow: production health, briefing, interactive issue creation, and watcher queue setup. Run this while drinking coffee before heading to the boathouse.

## Usage

```
/morning-coffee
/morning-coffee "Focus on reservation system bugs"
```

## Arguments

Optional: a custom focus area for the day (e.g., "onboarding week", "equipment bugs").

## Workflow

### Step 1: Production Health Check

Run all three monitoring tools in parallel:

```
mcp__radl-ops__health_check({})
mcp__radl-ops__alert_check({})
mcp__radl-ops__production_status({})
```

Summarize the results. If any critical alerts exist, flag them prominently.

### Step 2: Generate Briefing

```
mcp__radl-ops__enable_tools({ group: "content", action: "enable" })
mcp__radl-ops__daily_briefing({
  create_issues: true,
  monitoring_context: "<health + alerts from step 1>",
  custom_focus: "<user's argument, if provided>"
})
```

The `create_issues: true` flag causes the briefing to auto-create draft GitHub issues from deferred items and production alerts (max 3).

### Step 3: Show Draft Issues

Present the user with:
1. Any issues auto-created by the briefing (from step 2)
2. A summary of the watcher queue (any `approved` issues already waiting)

```
mcp__github__list_issues({
  owner: "Sn1ckerDood1e",
  repo: "Radl",
  labels: "approved",
  state: "open",
  minimal_output: true
})
```

### Step 4: Interactive Planning

Ask the user:
1. **Which auto-created issues to approve** — add `approved` label to selected ones
2. **Any new issues to add** — if the user describes new work, create issues using the standard template format:

```markdown
## What
[One-sentence deliverable]

## Why
[2-3 sentences of context]

## Acceptance Criteria
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

## Scope
Files/modules: [list or describe]
Do NOT touch: [exclusions]
```

For each new issue:
```
mcp__github__issue_write({
  owner: "Sn1ckerDood1e",
  repo: "Radl",
  title: "<issue title>",
  body: "<formatted body>",
  labels: ["approved", "watcher"]
})
```

### Step 5: Priority Ordering

If the user has preferences about execution order, add priority labels:
- `priority:high` — execute first
- (no label) — default priority
- `priority:low` — execute last

### Step 6: Summary

Print a summary:
```
## Morning Plan

**Production:** [OK / issues found]
**Watcher queue:** X issues ready
**New issues created:** Y
**Estimated autonomous work:** ~Z hours

Go coach! The watcher will process these while you're at the boathouse.
```

### Error Handling

- If health_check or alert_check fails, continue without monitoring context
- If briefing fails, skip to step 3 (manual issue listing)
- If GitHub is unreachable, show issue titles/descriptions for manual creation later
- Never block the planning session on a single failed step

## Notes

- The watcher picks up `approved` issues within 60 seconds
- Issues are processed serially (one at a time)
- `priority:high` issues execute first
- The user can monitor progress from their phone via GitHub notifications
- Each issue gets its own feature branch and PR
