# Radl Development Workflow

**Version:** 2.1
**Purpose:** Quality-focused autonomous development for solo founder

## Design Principles

1. **State survives context** - STATE.md is the single source of truth
2. **Verification is mandatory** - Every sprint ends with a check
3. **Minimal commands** - 5 for BUILD, 6 for MAINTAIN
4. **Smart delegation** - Right agent for right task
5. **Atomic commits** - Every change revertable
6. **Security by default** - Auto-review on sensitive code

---

## BUILD Mode (v4.0 Development)

Use this mode when building new features for a milestone.

### The Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   BRIEF ──► SPRINT ──► VERIFY ──► UPDATE ──► BRIEF             │
│     │                               │                           │
│     └───────────────────────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Phase | Duration | User Input | Output |
|-------|----------|------------|--------|
| **BRIEF** | 5 min | "What's next?" | Today's sprint scope |
| **SPRINT** | 1-4 hrs | "Go" | Code + commits |
| **VERIFY** | 10 min | "Does it work?" | Pass/fail |
| **UPDATE** | 2 min | None | STATE.md + ROADMAP.md |

### Commands

| Command | Purpose | User Input |
|---------|---------|------------|
| `/build` | Start a sprint | Feature or phase number |
| `/verify` | Check sprint output | Yes/no on test results |
| `/fix` | Fix verification failures | None (auto) |
| `/status` | Show current position | None |
| `/pause` | Save context for later | None |

### How `/build` Works

**Input:** Feature description, phase number, or "continue"

**Process:**

```
1. CONTEXT LOAD (2 min)
   ├── Read STATE.md (current position)
   ├── Read ROADMAP.md (phase requirements)
   └── Read recent git log (patterns)

2. PLAN (5 min, in-context only)
   ├── Break into 3-7 tasks
   ├── Identify files to change
   ├── Note any risks
   └── Output plan summary (no file created)

3. CONFIRM (one prompt)
   └── "Sprint scope: [X]. Ready?" → User says "go"

4. IMPLEMENT (autonomous)
   For each task:
   ├── Delegate to tdd-guide agent (tests first)
   ├── On error → build-error-resolver agent
   ├── On complete → code-reviewer agent
   └── Commit atomically

5. SUMMARY (2 min)
   └── Output what was built + any issues
```

**Deviation Rules:**

| Situation | Action |
|-----------|--------|
| Build error | Auto-fix with build-error-resolver |
| Test failure | Fix implementation |
| Lint error | Auto-fix |
| Type error | Fix types |
| **Architectural decision** | **STOP and ask** |
| **Scope creep detected** | **STOP and confirm** |

### How `/verify` Works

**Mandatory checks (automated):**
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes (if exists)
- [ ] `npx prisma migrate status` - no pending migrations
- [ ] No console.log in production code
- [ ] Test coverage >= 80% (if coverage script exists)

**User checks (prompted):**
- [ ] Feature works as expected (manual test)
- [ ] UI looks correct (if applicable)

**Outcomes:**

| Result | Next Step |
|--------|-----------|
| **PASS** | Update STATE.md, mark ROADMAP.md checkbox |
| **FAIL** | Run `/fix` to address issues |
| **PARTIAL** | Note what works, create follow-up sprint |

### How `/fix` Works

**Input:** Verification failure reason

**Process:**
1. Analyze failure
2. Create minimal fix plan
3. Execute fix (same agents as /build)
4. Re-run verification checks
5. Loop until pass or escalate to user

### State Management

**STATE.md (always maintained):**

```markdown
## Current Position
| Field | Value |
|-------|-------|
| Mode | BUILD |
| Milestone | v4.0 Spring Launch |
| Phase | 41 - Practice UX |
| Last Sprint | Simple practice form |
| Sprint Status | VERIFIED |
| Next Sprint | Bulk creator tooltips |

## Sprint Log
| Date | Sprint | Status | Commits |
|------|--------|--------|---------|
| 2026-02-04 | Simple practice form | VERIFIED | abc123, def456 |
| 2026-02-03 | Practice choice page | VERIFIED | 789ghi |

## Blockers
- None currently
```

**ROADMAP.md (phase checkboxes):**

```markdown
#### Phase 41: Practice UX Improvements
- [x] Practice creation choice page
- [x] Simple practice form
- [ ] Bulk creator tooltips
- [ ] Mobile publish button fix
```

### Parallel Execution

For independent tasks within a sprint, spawn parallel agents:

```
/build "Phase 41 remaining tasks"

Sprint spawns 3 agents in parallel:
├── Agent 1: Bulk creator tooltips
├── Agent 2: Mobile publish button
└── Agent 3: Role management dropdown

Each agent:
- Gets isolated context
- Uses tdd-guide internally
- Commits independently
- Returns summary
```

**Merge strategy:** Sequential commits to avoid conflicts. Main agent waits for all, then runs unified verification.

---

## MAINTAIN Mode (Post-Launch)

Use this mode after v4.0 ships for bug fixes, small improvements, and support.

### The Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   TRIAGE ──► FIX ──► VERIFY ──► CLOSE                          │
│      │                           │                              │
│      └───────────────────────────┘                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Commands

| Command | Purpose | User Input |
|---------|---------|------------|
| `/triage` | Review incoming issues | Priority assignment |
| `/fix <issue>` | Fix a specific issue | Issue number or description |
| `/verify` | Same as BUILD mode | Yes/no |
| `/release` | Tag and deploy | Version number |
| `/hotfix` | Emergency production fix | Issue description |
| `/rollback` | Revert bad deployment | Commit hash or "last" |

### How `/triage` Works

**Sources checked:**
- GitHub issues (via MCP)
- Sentry errors (when configured)
- User feedback (Slack/email)

**Output:**
```
📥 INCOMING ISSUES

🔴 CRITICAL (fix today)
- #123: Login fails on iOS Safari

🟡 HIGH (fix this week)
- #124: Equipment list slow with 100+ items
- #125: Notification not showing on Android

🟢 NORMAL (backlog)
- #126: Add dark mode to settings
- #127: Export to PDF feature request

Which to fix first?
```

### How `/fix <issue>` Works

**Process:**
1. Read issue details (GitHub API)
2. Reproduce locally if possible
3. Identify root cause
4. Create minimal fix
5. Write regression test
6. Commit with `fix: #issue description`
7. Run verification

**Commit format:**
```
fix: #123 login fails on iOS Safari

- Root cause: Safari cookie handling
- Added SameSite=None for cross-origin
- Regression test: e2e/auth/ios-safari.spec.ts
```

### Issue-Driven Learning

After fixing 3+ similar issues, extract pattern:

```
Pattern detected: iOS Safari auth issues (3 occurrences)

Creating instinct:
- Name: ios-safari-auth
- Trigger: Auth code + Safari mention
- Action: Check SameSite cookie settings
- Confidence: 0.7
```

### How `/hotfix` Works

**For P0/P1 production emergencies only:**

```
1. TRIAGE SEVERITY
   └── If not P0/P1, redirect to /fix

2. DIAGNOSE (fast)
   ├── Check Supabase logs
   ├── Check Vercel deployments
   └── Identify root cause

3. FIX (minimal)
   ├── Smallest possible change
   ├── Skip code review (speed > polish)
   ├── Regression test required
   └── Commit with hotfix: prefix

4. DEPLOY
   └── Push to main, monitor deployment

5. VERIFY
   ├── Check deployment succeeded
   ├── Verify error logs cleared
   └── Create post-mortem issue
```

### How `/rollback` Works

**For bad deployments:**

```
1. IDENTIFY TARGET
   ├── "last" → previous commit
   ├── Commit hash → specific commit
   └── Show commits to be reverted

2. CONFIRM
   └── User must approve

3. EXECUTE
   ├── git revert (preserves history)
   └── Push to main

4. VERIFY
   └── Confirm Vercel deployment succeeded
```

---

## Agent Delegation

### Model Routing

| Task Type | Model | Agent |
|-----------|-------|-------|
| Planning complex feature | Opus | planner |
| Writing new code | Sonnet | tdd-guide |
| Reviewing code | Sonnet | code-reviewer |
| Fixing build errors | Sonnet | build-error-resolver |
| Security-sensitive code | Opus | security-reviewer |
| Simple refactoring | Haiku | - |
| Documentation | Haiku | doc-updater |

### When to Spawn Subagents

| Situation | Spawn? | Agent |
|-----------|--------|-------|
| New component (>50 lines) | Yes | tdd-guide |
| API endpoint | Yes | tdd-guide + security-reviewer |
| Database migration | Yes | database-reviewer |
| Build broken | Yes | build-error-resolver |
| Code written | Yes | code-reviewer (automatic) |
| E2E test needed | Yes | e2e-runner |
| Simple edit (<20 lines) | No | Direct |

---

## Quality Gates

### Pre-Commit (Automatic)

```bash
# Runs before every commit
npm run typecheck && npm run lint
```

### Pre-Sprint-Complete

- [ ] All tasks committed
- [ ] Build passes
- [ ] No new lint errors
- [ ] Code reviewed (agent)

### Pre-Phase-Complete

- [ ] All sprint checkboxes in ROADMAP.md checked
- [ ] Manual verification passed
- [ ] No open blockers

### Pre-Milestone-Complete

- [ ] All phases complete
- [ ] E2E tests pass for critical flows
- [ ] Security review on sensitive areas
- [ ] STATE.md milestone summary written

---

## File Structure

```
/home/hb/radl/.planning/
├── STATE.md              # Single source of truth (always loaded)
├── ROADMAP.md            # Phase checkboxes (always loaded)
└── PROJECT.md            # Vision reference (loaded on request)

No per-phase files. No CONTEXT.md. No PLAN.md. No SUMMARY.md.
```

**Why minimal files:**
- STATE.md + ROADMAP.md = ~500 tokens loaded
- GSD loads 4-5 files = ~2000+ tokens
- More context available for actual work

---

## Context Survival

### What Survives Context Reset

| Artifact | Location | Survives? |
|----------|----------|-----------|
| Current position | STATE.md | ✅ |
| Sprint log | STATE.md | ✅ |
| Phase progress | ROADMAP.md | ✅ |
| Git commits | Repository | ✅ |
| Sprint plan | Conversation | ❌ |
| In-progress work | Working tree | ✅ |

### Recovery After Reset

```
/status

📍 CURRENT POSITION
- Mode: BUILD
- Milestone: v4.0 Spring Launch
- Phase: 41 - Practice UX
- Last Sprint: Simple practice form (VERIFIED)
- Next Sprint: Bulk creator tooltips

📋 UNCOMMITTED CHANGES
- src/components/practices/bulk-creator.tsx (modified)

🔄 RESUME
Run: /build continue
```

---

## Daily Operations

### Morning (Automated Briefing)

```
📍 POSITION: Phase 41, Sprint 3 of 4

🎯 TODAY'S SPRINT
Bulk creator tooltips

🔧 COMMAND
/build "bulk creator tooltips"

📊 MILESTONE
v4.0: 1/11 phases complete
```

### During Work

```bash
/build "feature"    # Start sprint
/status             # Check position
/pause              # Save for later
```

### End of Day

```bash
/verify             # Check today's work
# If pass: auto-updates STATE.md
# If fail: /fix or /pause for tomorrow
```

---

## Branch Strategy

**Default: Work on main**

For solo development, work directly on `main`:
- Simpler workflow
- No merge conflicts with yourself
- Vercel auto-deploys on push

**When to use feature branches:**

| Situation | Use Branch? |
|-----------|-------------|
| Normal sprint work | No - main |
| Experimental feature | Yes - `feat/experiment-name` |
| Major refactor | Yes - `refactor/description` |
| Parallel work (rare) | Yes - separate branches |

**Branch naming:**
```
feat/practice-creation-form
fix/ios-safari-auth
refactor/equipment-api
hotfix/login-broken
```

---

## Context Window Management

### When to Clear

| Trigger | Action |
|---------|--------|
| After verified sprint | `/clear` then `/status` |
| At ~80% context usage | `/pause` then `/clear` then `/build continue` |
| After complex debugging | `/clear` - start fresh |
| Context feels sluggish | `/clear` - it's fine |

### Low-Context Sensitivity Tasks

Safe to do near context limit:
- Single file edits
- Bug fixes
- Documentation
- Simple commits

### High-Context Sensitivity Tasks

Do early in session (fresh context):
- Multi-file refactoring
- New feature implementation
- Complex debugging
- API endpoint creation

### Recovery Pattern

```bash
# Near context limit with work in progress
/pause                  # Save state to STATE.md
# Commit any WIP if needed
/clear                  # Fresh context
/status                 # Reload position
/build continue         # Resume
```

---

## Comparison: Before vs After

| Aspect | GSD (Before) | Radl Workflow (After) |
|--------|--------------|----------------------|
| Files per phase | 4-5 | 0 |
| User prompts per sprint | 5-10 | 2 |
| Commands to learn | 15+ | 5 (BUILD) / 6 (MAINTAIN) |
| Token overhead | High | Low (~500 tokens) |
| Context survival | Full | Essential only |
| Verification | Heavy ceremony | Lightweight + mandatory |
| Parallel execution | Wave-based | Task-based |
| Security review | Manual | Auto on sensitive files |
| Migration handling | None | Built into /verify |
| Emergency recovery | None | /hotfix + /rollback |

---

## When to Use GSD Instead

Fall back to `/gsd:*` commands when:
- Unclear requirements need discussion
- Major architectural decision needed
- New milestone with no prior context
- Complex multi-week feature

GSD commands still work. This workflow is the default, not a replacement.

---

*"Build. Verify. Ship. Repeat."*
