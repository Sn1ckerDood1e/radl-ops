# Session Workflow

Standard workflow for every Claude Code session working on Radl.

## Session Start

1. **Check sprint state**: `sprint.sh status`
2. **Check service health**: Use `mcp__radl-ops__health_check` if available
3. **Review STATE.md**: Read `/home/hb/radl/.planning/STATE.md` for context
4. **Create feature branch** if starting new work (never work on main)

## During Session

### Branch Discipline
- ALL work happens on feature branches
- Branch naming: `feat/<scope>`, `fix/<scope>`, `refactor/<scope>`
- Commit early and often with conventional commit messages
- Never commit to main directly

### Sprint Tracking
- Start sprint before beginning work: `sprint.sh start`
- Log progress after each task: `sprint.sh progress "message"`
- Record blockers immediately: `sprint.sh blocker "description"`
- Checkpoint every 30-45 minutes: `sprint.sh checkpoint`

### Context Management
- Monitor context window usage
- At ~60% context: Consider if remaining tasks can fit
- At ~75% context: Use `/strategic-compact` skill
- Before compaction: Save sprint state via `sprint.sh checkpoint`

### Code Quality Gates
After writing or modifying code:
1. `npm run typecheck` — must pass
2. Use **code-reviewer** agent for non-trivial changes
3. Use **security-reviewer** agent for auth/API/input handling changes

## Session End

1. **Complete sprint** (if finishing):
   ```bash
   sprint.sh complete "$(git rev-parse --short HEAD)" "actual_time"
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
