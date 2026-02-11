# Session Workflow

Standard workflow for every Claude Code session working on Radl.

## Session Start

1. **Check sprint state**: Use `mcp__radl-ops__sprint_status` MCP tool
2. **Check service health**: Use `mcp__radl-ops__health_check` if available
3. **Parallel context loading**: Read ALL needed files in a single batch of parallel Read calls:
   - `/home/hb/radl/.planning/STATE.md` for current progress
   - ALL source files you plan to modify (read them together, not one-at-a-time)
   - Any test files for areas being modified
   - For 10+ files, batch into 2-3 parallel Read calls (5 files each)
4. **Create feature branch** if starting new work (never work on main)

## During Session

### Branch Discipline
- ALL work happens on feature branches
- Branch naming: `feat/<scope>`, `fix/<scope>`, `refactor/<scope>`
- Commit early and often with conventional commit messages
- Never commit to main directly

### Sprint Tracking (use MCP tools, not shell scripts)
- Start sprint: `mcp__radl-ops__sprint_start`
- Log progress after each commit: `mcp__radl-ops__sprint_progress`
- Record blockers immediately: `sprint.sh blocker "description"`
- Checkpoint every 30-45 minutes: `sprint.sh checkpoint`

### Research Before Implementation
- When using an external API or library for the first time, query context7:
  ```
  mcp__context7__resolve-library-id → mcp__context7__query-docs
  ```
- This prevents API misuse bugs that only get caught in review

### Mid-Sprint Review Gate
After completing a task that introduces a **new pattern**:
- Spawn background code-reviewer + security-reviewer sub-agents
- Continue to next task while they run (~2-3 min)
- Fix HIGH issues before they propagate
- Skip this for tasks that follow existing patterns

### Context Management
- Monitor context window usage
- At ~60% context: Consider if remaining tasks can fit
- At ~75% context: Use `/strategic-compact` skill
- Before compaction: Save sprint state via `sprint.sh checkpoint`

### Data Flow Verification (CRITICAL for UI changes)
When adding new data to a list page or card component, always trace the full path:
1. **Prisma query** — Does it include the new relations/fields?
2. **Server page** — Does the props mapping pass the new fields to the client?
3. **Client component** — Does it accept and forward the fields to child components?
4. **Render** — Does the child component actually display them?

If any layer explicitly maps props (e.g., `.map(e => ({ id: e.id, ... }))`), new
fields will be **silently dropped** unless added to the mapping. This was a real bug
in Phase 60: API + client updated, but server page mapping dropped maintenance fields.

### Code Quality Gates
After writing or modifying code:
1. `npm run typecheck` — must pass
2. Use **code-reviewer** AND **security-reviewer** agents for non-trivial changes
   (launch both in parallel with `run_in_background: true`)
3. Never skip security-reviewer for auth, tier enforcement, or API boundary changes

## Session End

1. **Complete sprint** (if finishing):
   ```
   mcp__radl-ops__sprint_complete(commit: "$(git rev-parse --short HEAD)", actual_time: "X hours")
   ```
2. **Or checkpoint** (if pausing):
   ```bash
   sprint.sh checkpoint
   ```
3. **Update STATE.md** with:
   - Current phase/sprint status
   - What was completed
   - What's next
   - Any blockers or tech debt discovered
4. **Extract learnings**: `compound.sh extract`
5. **Push feature branch**: `git push -u origin <branch>`

## STATE.md Update Template

When updating STATE.md, ensure these fields are current:
- Mode (BUILD/MAINTAIN)
- Current milestone/phase/sprint
- Sprint status (Active/Complete/Paused)
- Last session date
- Recent sprint log entries
- Any new tech debt items
