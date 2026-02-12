# Radl Ops

MCP server providing ops tools for Radl (rowing team management SaaS).

Claude Code IS the agent. radl-ops is a tool provider via MCP.

## MCP Tools

Available as `mcp__radl_ops__*` in Claude Code. Tools are organized into groups with on-demand loading.

### Tool Groups (Dynamic Loading)

| Group | Default | Tools |
|-------|---------|-------|
| **core** | Enabled | health_check, sprint_*, iron_laws, cost_report, knowledge_query, verify, team_recipe, audit_triage, sprint_advisor, review_pipeline |
| **content** | Disabled | daily_briefing, weekly_briefing, social_*, roadmap_ideas |
| **advanced** | Disabled | eval_opt_generate, compound_extract |

To enable disabled tool groups: `mcp__radl-ops__enable_tools({ group: "content", action: "enable" })`

### All Tools

| Tool | Group | Description |
|------|-------|-------------|
| `enable_tools` | meta | Enable/disable tool groups on demand |
| `daily_briefing` | content | Daily briefing via eval-opt quality loop (Haiku generates, Sonnet evaluates) |
| `weekly_briefing` | content | Weekly briefing via eval-opt quality loop |
| `roadmap_ideas` | content | Brainstorm features via Opus |
| `social_ideas` | content | Content ideas with Radl brand context |
| `social_draft` | content | Draft posts for Twitter/LinkedIn |
| `social_calendar` | content | Weekly content calendar |
| `health_check` | core | Aggregated Vercel/Supabase/GitHub status |
| `sprint_status` | core | Current sprint state |
| `sprint_start` | core | Start a new sprint (Slack notification) |
| `sprint_progress` | core | Record task completion |
| `sprint_complete` | core | Complete sprint, trigger compound learning |
| `cost_report` | core | API costs from radl-ops internal Claude calls |
| `knowledge_query` | core | Query compound learnings (patterns, lessons, decisions) |
| `iron_laws` | core | List all iron laws and current branch status |
| `team_recipe` | core | Get structured agent team recipe (review, feature, debug, research, migration, test-coverage, refactor) |
| `audit_triage` | core | Classify audit findings into DO_NOW/DO_SOON/DEFER via Haiku |
| `sprint_advisor` | core | AI-powered analysis of sprint tasks to recommend team usage |
| `review_pipeline` | core | Complete review workflow: recipe + triage template + orchestration checklist |
| `eval_opt_generate` | advanced | Generate content with eval-opt quality loop (any prompt + criteria) |
| `compound_extract` | advanced | AI-powered compound learning extraction via Bloom pipeline |

## MCP Resources

Read-only state exposed as MCP resources (no tool call needed). Clients can subscribe to these for efficient state inspection.

| URI | Description |
|-----|-------------|
| `sprint://current` | Current sprint state + active git branch |
| `config://iron-laws` | Non-negotiable constraints (all 6 laws) |
| `config://tool-groups` | Tool group enabled/disabled status |

## MCP Prompts

Workflow templates exposed as MCP prompts. Appear as prompt selections in compatible clients.

| Prompt | Args | Description |
|--------|------|-------------|
| `sprint-start` | phase, title, estimate? | Pre-filled sprint start workflow |
| `sprint-review` | phase, branch? | End-of-sprint review checklist |
| `code-review` | files, focus? | Structured code review with severity levels |

## Tool Annotations

All tools include `ToolAnnotations` metadata (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) enabling MCP clients to make UX decisions about tool behavior.

## Architecture

```
Claude Code <--(stdio/JSON-RPC)--> radl-ops MCP Server (v1.4.0)
                                    ├── tools (21 tools, 3 groups, with annotations)
                                    ├── resources (3: sprint, iron-laws, tool-groups)
                                    ├── prompts (3: sprint-start, sprint-review, code-review)
                                    ├── briefing tools (eval-opt: Haiku+Sonnet)
                                    ├── social tools (Sonnet + Radl brand context)
                                    ├── monitoring tools (HTTP health checks)
                                    ├── sprint tools (wrap sprint.sh)
                                    ├── team recipes (8 recipes: review, feature, debug, research, incremental-review, migration, test-coverage, refactor)
                                    ├── sprint advisor (Haiku-powered team recommendation)
                                    ├── review pipeline (chained review → triage → tracking)
                                    ├── eval-opt (generate→evaluate→refine with memory + caching)
                                    ├── compound learning (Bloom pipeline: 4-stage AI extraction)
                                    └── cost reporting (token tracking with cache metrics)
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
5. **Extract learnings** — `compound_extract` MCP tool (or `compound.sh extract` as fallback)

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

# Compound learning (after sprints) — prefer MCP tool over shell
# mcp__radl-ops__compound_extract (AI-powered Bloom pipeline)
/home/hb/radl-ops/scripts/compound.sh extract  # legacy fallback
```

## Automated Tasks (Cron)

Install with: `bash /home/hb/radl-ops/scripts/cron-setup.sh`

| Schedule | Script | Purpose |
|----------|--------|---------|
| @reboot | briefing-on-wake.sh | Daily/weekly briefing on WSL start |
| 0 0 * * * | cleanup-logs.sh | Delete usage logs older than 90 days |
| 0 18 * * * | cost-alert.sh | Slack alert if daily spend exceeds threshold |

## Model Routing (internal)

- **Haiku**: Briefing drafts, spot checks, social ideas, Bloom understanding/rollout stages
- **Sonnet**: Evaluator, social drafts/calendar, conversations, Bloom ideation/judgment stages
- **Opus**: Roadmap ideation (deep reasoning)

Task types: `briefing`, `tool_execution`, `conversation`, `planning`, `review`, `architecture`, `roadmap`, `spot_check`, `social_generation`

Briefings use eval-opt loop: Haiku generates, Sonnet evaluates (quality threshold 7/10).
Eval-opt uses structured outputs (tool_use + forced tool_choice) for reliable JSON parsing.
Eval-opt tracks all iteration attempts and uses prompt caching for evaluation criteria.
Bloom pipeline uses structured outputs for rollout (lessons array) and judgment (quality score) stages.

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
