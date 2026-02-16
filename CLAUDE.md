# Radl Ops

MCP server providing ops tools for Radl (rowing team management SaaS).

Claude Code IS the agent. radl-ops is a tool provider via MCP.

## MCP Tools

Available as `mcp__radl_ops__*` in Claude Code. Tools are organized into groups with on-demand loading.

### Tool Groups (Dynamic Loading)

| Group | Default | Tools |
|-------|---------|-------|
| **core** | Enabled | health_check, sprint_*, iron_laws, cost_report, knowledge_query, verify, team_recipe, audit_triage, sprint_advisor, review_pipeline, sprint_decompose, verify_patterns, sprint_conductor, verify_data_flow, pre_flight_check, spot_check_diff, deferred_triage, sprint_retrospective, auto_prioritize, spec_to_tests, crystallize_*, antibody_*, causal_extract, causal_query, inverse_bloom, trust_report, trust_record, speculative_validate, cognitive_load |
| **content** | Disabled | daily_briefing, weekly_briefing, social_*, roadmap_ideas |
| **advanced** | Disabled | eval_opt_generate, compound_extract, tool_forge, counterfactual_analyze |

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
| `sprint_complete` | core | Complete sprint, auto-extract compound learnings via Bloom pipeline |
| `cost_report` | core | API costs from radl-ops internal Claude calls |
| `knowledge_query` | core | Query compound learnings (patterns, lessons, decisions) |
| `iron_laws` | core | List all iron laws and current branch status |
| `team_recipe` | core | Get structured agent team recipe (review, feature, debug, research, migration, test-coverage, refactor) |
| `audit_triage` | core | Classify audit findings into DO_NOW/DO_SOON/DEFER via Haiku |
| `sprint_advisor` | core | AI-powered analysis of sprint tasks to recommend team usage |
| `review_pipeline` | core | Complete review workflow: recipe + triage template + orchestration checklist |
| `sprint_decompose` | core | Auto-decompose sprint into structured tasks with AI (Haiku). Returns TaskCreate-ready JSON |
| `verify_patterns` | core | Check git diffs against knowledge base patterns. Detects drift before PR |
| `sprint_conductor` | core | Full sprint orchestration: knowledge → eval-opt spec → decompose → execution plan |
| `verify_data_flow` | core | Zero-cost field lifecycle check (Schema→Migration→Validation→API→Client) |
| `pre_flight_check` | core | Zero-cost pre-push verification (branch, sprint, clean tree, typecheck, secrets) |
| `spot_check_diff` | core | AI spot-check of git diffs for common mistakes |
| `deferred_triage` | core | Manage deferred tech debt items lifecycle |
| `sprint_retrospective` | core | AI-powered sprint retrospective analysis |
| `auto_prioritize` | core | AI-prioritize deferred items by impact/effort |
| `spec_to_tests` | core | Generate test specs from acceptance criteria |
| `crystallize_propose` | core | Propose checks from high-frequency lessons (Haiku) |
| `crystallize_approve` | core | Approve a proposed crystallized check |
| `crystallize_demote` | core | Demote a crystallized check with reason |
| `crystallize_list` | core | List crystallized checks by status |
| `antibody_create` | core | Create antibody from bug description (Haiku) |
| `antibody_list` | core | List active/all antibodies |
| `antibody_disable` | core | Deactivate an antibody |
| `causal_extract` | core | Extract decision→outcome pairs from sprint data (Haiku) |
| `causal_query` | core | Query causal graph by node or keywords (zero-cost BFS) |
| `inverse_bloom` | core | Zero-cost knowledge injection for sprint tasks |
| `trust_report` | core | Zero-cost analytics per domain (success rate, override rate) |
| `trust_record` | core | Record decision outcome for quality ratchet |
| `speculative_validate` | core | Zero-cost pre-validation against knowledge base (5 checks) |
| `cognitive_load` | core | Zero-cost context window overflow prediction |
| `eval_opt_generate` | advanced | Generate content with eval-opt quality loop (any prompt + criteria) |
| `compound_extract` | advanced | AI-powered compound learning extraction via Bloom pipeline |
| `tool_forge` | advanced | Generate MCP tool code from crystallized checks or antibodies (Sonnet) |
| `counterfactual_analyze` | advanced | Analyze alternative sprint outcomes with causal context (Sonnet) |

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
Claude Code <--(stdio/JSON-RPC)--> radl-ops MCP Server (v2.0.0)
                                    ├── tools (44 tools, 3 groups, with annotations)
                                    ├── resources (3: sprint [cached], iron-laws, tool-groups)
                                    ├── prompts (3: sprint-start, sprint-review, code-review)
                                    ├── sprint conductor (knowledge → inverse bloom → speculative validate → plan)
                                    ├── closed-loop intelligence:
                                    │   ├── immune system (antibody_create/list/disable)
                                    │   ├── crystallization (propose/approve/demote/list)
                                    │   ├── causal graphs (extract/query)
                                    │   ├── inverse bloom (zero-cost knowledge injection)
                                    │   ├── speculative validation (5 zero-cost pre-checks)
                                    │   ├── cognitive load prediction (overflow forecasting)
                                    │   ├── quality ratchet (trust_report/trust_record)
                                    │   ├── tool forge (Sonnet code gen from checks)
                                    │   └── counterfactual analysis (alternative outcome reasoning)
                                    ├── briefing tools (eval-opt: Haiku+Sonnet)
                                    ├── social tools (Sonnet + Radl brand context)
                                    ├── monitoring tools (HTTP health checks)
                                    ├── sprint tools (wrap sprint.sh, auto compound extract)
                                    ├── team recipes (8 recipes)
                                    ├── sprint advisor + decompose (AI task planning)
                                    ├── review pipeline (chained review → triage → tracking)
                                    ├── eval-opt (generate→evaluate→refine with memory + caching)
                                    ├── compound learning (Bloom pipeline: 4-stage AI extraction)
                                    ├── data flow verifier (zero-cost field lifecycle check)
                                    ├── pre-flight check (zero-cost pre-push verification)
                                    ├── drift detection (verify code against knowledge base patterns)
                                    ├── per-sprint cost tracking (tags API calls with active phase)
                                    └── cost reporting (token tracking with cache + sprint metrics)
```

## Hooks (Automatic Enforcement)

10 hooks across 7 Claude Code lifecycle events. All quality gates fire automatically.

| Hook | Type | Event | Purpose |
|------|------|-------|---------|
| Full Context Restore | command | SessionStart | Re-injects sprint state, branch, patterns every session |
| Pre-Compact Save | command | PreCompact | Auto-checkpoints sprint state before compaction |
| Risk Classifier | command | PreToolUse (Bash) | Classifies commit risk by files touched |
| Sprint Guard | command | PreToolUse (Bash) | Warns if committing without active sprint |
| Push Pre-Flight | command | PreToolUse (Bash) | Runs pre_flight_check before git push |
| Branch Guard | command | PreToolUse (Bash) | Blocks pushes to main/master |
| Typecheck After Edit | command | PostToolUse (Edit/Write) | Runs tsc after editing .ts/.tsx files |
| Task Review Detector | agent | TaskCompleted | Inspects git diff for new patterns, recommends review |
| Session Verify | agent | Stop | Verifies STATE.md updated, sprint tracked, no uncommitted changes |
| Build Self-Healer | agent | PostToolUseFailure | Auto-diagnoses build/typecheck failures |

Hook scripts live in `scripts/hooks/`. Agent hooks are configured in `~/.claude/settings.json`.

## Skills (Autonomous Workflows)

| Skill | Description |
|-------|-------------|
| `/sprint-execute` | One command, full autonomous sprint. Chains conductor → approve → branch → tasks → team → review → PR → learn |

Usage: `/sprint-execute "Add practice attendance tracking"`

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
2. **Track sprint** — `sprint_start` MCP tool before work, `sprint_progress` during
3. **Review code** — Use code-reviewer agent after writing code
4. **Update STATE.md** — At session end, update `/home/hb/radl/.planning/STATE.md`
5. **Extract learnings** — Auto-extracted by `sprint_complete` (Bloom pipeline)

For autonomous sprints, use `/sprint-execute "feature description"` instead.

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
