# Radl Ops

MCP server providing ops tools for Radl (rowing team management SaaS).

Claude Code IS the agent. radl-ops is a tool provider via MCP.

## MCP Tools

Available as `mcp__radl_ops__*` in Claude Code:

| Tool | Description |
|------|-------------|
| `daily_briefing` | Daily briefing via eval-opt quality loop (Haiku generates, Sonnet evaluates) |
| `weekly_briefing` | Weekly briefing via eval-opt quality loop |
| `roadmap_ideas` | Brainstorm features via Opus |
| `social_ideas` | Content ideas with Radl brand context |
| `social_draft` | Draft posts for Twitter/LinkedIn |
| `social_calendar` | Weekly content calendar |
| `health_check` | Aggregated Vercel/Supabase/GitHub status |
| `sprint_status` | Current sprint state |
| `sprint_start` | Start a new sprint (Slack notification) |
| `sprint_progress` | Record task completion |
| `sprint_complete` | Complete sprint, trigger compound learning |
| `cost_report` | API costs from radl-ops internal Claude calls |
| `knowledge_query` | Query compound learnings (patterns, lessons, decisions) |
| `iron_laws` | List all iron laws and current branch status |

## Architecture

```
Claude Code <--(stdio/JSON-RPC)--> radl-ops MCP Server
                                    ├── briefing tools (eval-opt: Haiku+Sonnet)
                                    ├── social tools (Sonnet + Radl brand context)
                                    ├── monitoring tools (HTTP health checks)
                                    ├── sprint tools (wrap sprint.sh)
                                    └── cost reporting (in-memory token tracking)
```

## Iron Laws (NEVER violate)

1. Never push directly to `main` branch — always use feature branches + PRs
2. Never delete production data
3. Never commit secrets (API keys, passwords, tokens)
4. Never modify CI/CD pipelines without explicit approval
5. Never change Vercel environment variables without explicit approval
6. After 3 failures on the same issue, STOP and escalate to user

## Session Workflow (MANDATORY)

@.claude/workflows/session-workflow.md

Every session MUST follow:
1. **Branch first** — `git checkout -b feat/<scope>` before any code changes
2. **Track sprint** — `sprint.sh start` before work, `sprint.sh progress` during
3. **Review code** — Use code-reviewer agent after writing code
4. **Update STATE.md** — At session end, update `/home/hb/radl/.planning/STATE.md`
5. **Extract learnings** — `compound.sh extract` after completing sprint

## Sprint Workflow

@.claude/workflows/autonomous-sprint.md

## Decision Heuristics

@.claude/rules/autonomy.md

## Monitoring

@.claude/rules/monitoring.md

## Project Context

- **Radl repo**: `/home/hb/radl/` -> GitHub `Sn1ckerDood1e/Radl`
- **Core value**: Coaches plan practices with lineups; athletes know where to be

## Commands

```bash
# Run MCP server (registered in ~/.mcp.json, starts automatically)
npm run mcp

# Tests
npm run test
npm run typecheck

# Sprint management (also available via MCP tools)
/home/hb/radl-ops/scripts/sprint.sh start "Phase X" "Title" "3 hours"
/home/hb/radl-ops/scripts/sprint.sh progress "Task done" [--notify]
/home/hb/radl-ops/scripts/sprint.sh checkpoint
/home/hb/radl-ops/scripts/sprint.sh complete "commit" "1.5 hours"
/home/hb/radl-ops/scripts/sprint.sh status

# Compound learning (after sprints)
/home/hb/radl-ops/scripts/compound.sh extract
```

## Model Routing (internal)

- **Haiku**: Briefing drafts (cheap, fast generator)
- **Sonnet**: Evaluator, social drafts, conversations
- **Opus**: Roadmap ideation (deep reasoning)

Briefings use eval-opt loop: Haiku generates, Sonnet evaluates (quality threshold 7/10).

## Agent Teams

@.claude/workflows/agent-teams.md

Enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json`.
Use for parallel code review, multi-module features, debugging, and research.
See workflow doc for team recipes specific to Radl.

## Compaction Instructions

When context is compacted, ALWAYS preserve:
- Current sprint state (phase, title, completed tasks, blockers)
- Current feature branch name and PR status
- List of all files modified in this session with their purposes
- Any test commands that were run and their results
- Unresolved error messages or failing tests
- Current task ID and next steps from the task list
- Iron laws (never violate, even after compaction)
- STATE.md update status (was it updated this session?)
