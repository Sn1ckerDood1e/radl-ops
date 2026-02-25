# Radl Ops

MCP server providing ops tools for Radl (rowing team management SaaS).

Claude Code IS the agent. radl-ops is a tool provider via MCP.

## MCP Tools

Available as `mcp__radl_ops__*` in Claude Code. Tools are organized into groups with on-demand loading.

### Tool Groups

| Group | Tools |
|-------|-------|
| **core** | health_check, sprint_*, iron_laws, cost_report, knowledge_query, verify, team_recipe, audit_triage, sprint_advisor, review_pipeline, sprint_decompose, verify_patterns, sprint_conductor, verify_data_flow, pre_flight_check, spot_check_diff, deferred_triage, sprint_retrospective, auto_prioritize, spec_to_tests, crystallize_*, antibody_*, causal_extract, causal_query, inverse_bloom, trust_report, trust_record, speculative_validate, cognitive_load, record_review, resolve_review, production_status, session_health, alert_check |
| **content** | daily_briefing, weekly_briefing, daily_summary, social_*, roadmap_ideas |
| **advanced** | eval_opt_generate, compound_extract, tool_forge, counterfactual_analyze |

All tool groups are enabled by default. Use `mcp__radl-ops__enable_tools` to toggle groups if needed.

### All Tools

| Tool | Group | Description |
|------|-------|-------------|
| `enable_tools` | meta | Enable/disable tool groups on demand |
| `daily_briefing` | content | Daily briefing via eval-opt quality loop. Pass `create_issues: true` to auto-create draft GitHub issues from deferred items + production alerts (max 3/briefing). |
| `weekly_briefing` | content | Weekly briefing via eval-opt quality loop |
| `roadmap_ideas` | content | Brainstorm features via Opus |
| `social_ideas` | content | Content ideas with Radl brand context |
| `social_draft` | content | Draft posts for Twitter/LinkedIn |
| `social_calendar` | content | Weekly content calendar |
| `health_check` | core | Aggregated Vercel/Supabase/GitHub status |
| `sprint_status` | core | Current sprint state |
| `sprint_start` | core | Start a new sprint (Slack notification) |
| `sprint_progress` | core | Record task completion |
| `sprint_complete` | core | Complete sprint, auto-extract compound learnings via Bloom pipeline, compare validation warnings, record trust decisions |
| `cost_report` | core | API costs from radl-ops internal Claude calls |
| `knowledge_query` | core | Query compound learnings (patterns, lessons, decisions) |
| `iron_laws` | core | List all iron laws and current branch status |
| `team_recipe` | core | Get structured agent team recipe (review, feature, debug, research, incremental-review, migration, test-coverage, refactor, sprint-implementation) |
| `audit_triage` | core | Classify audit findings into DO_NOW/DO_SOON/DEFER via Haiku |
| `sprint_advisor` | core | AI-powered analysis of sprint tasks to recommend team usage |
| `review_pipeline` | core | Complete review workflow: recipe + triage template + orchestration checklist |
| `sprint_decompose` | core | Auto-decompose sprint into structured tasks with AI (Haiku). Returns TaskCreate-ready JSON |
| `verify_patterns` | core | Check git diffs against knowledge base patterns. Detects drift before PR |
| `sprint_conductor` | core | Full sprint orchestration: knowledge → inverse bloom → speculative validate → checkpointed plan |
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
| `record_review` | core | Record review findings for tracking across sprints |
| `resolve_review` | core | Mark review findings as resolved |
| `production_status` | core | Aggregated production health (Vercel + Supabase + Sentry) |
| `session_health` | core | Session progress tracking and rabbit hole detection |
| `alert_check` | core | Check for critical production alerts |
| `verify` | core | Verify task completion against acceptance criteria |
| `daily_summary` | content | End-of-day summary via eval-opt quality loop |
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
                                    ├── tools (56 tools, 3 groups + 1 meta, with annotations)
                                    ├── resources (3: sprint [cached], iron-laws, tool-groups)
                                    ├── prompts (3: sprint-start, sprint-review, code-review)
                                    ├── sprint conductor:
                                    │   ├── knowledge loading (patterns, lessons, deferred, estimation)
                                    │   ├── eval-opt spec (Sonnet generates, Opus evaluates)
                                    │   ├── task decomposition (Haiku, forced tool_use)
                                    │   ├── inverse bloom enrichment (time-decay weighted knowledge)
                                    │   ├── speculative validation (5 zero-cost pre-checks)
                                    │   ├── step-level checkpointing (SHA256 feature hash)
                                    │   └── plan traceability (commit-to-task matching)
                                    ├── closed-loop intelligence:
                                    │   ├── immune system (antibodies with chain matching)
                                    │   ├── crystallization (propose/approve/demote/list)
                                    │   ├── causal graphs (extract/query with BFS traversal)
                                    │   ├── inverse bloom (30-day half-life time decay)
                                    │   ├── speculative validation (5 zero-cost pre-checks)
                                    │   ├── cognitive load prediction (overflow forecasting + calibration)
                                    │   ├── quality ratchet (trust_report/trust_record per domain)
                                    │   ├── task verification (Antfarm verify-then-retry protocol)
                                    │   ├── validation follow-up (sprint_complete warning comparison)
                                    │   ├── tool forge (Sonnet code gen from checks)
                                    │   └── counterfactual analysis (alternative outcome reasoning)
                                    ├── knowledge infrastructure:
                                    │   ├── FTS5 BM25 search (better-sqlite3, embedding-ready)
                                    │   └── MITRE ATLAS threat model (knowledge/threats.yaml)
                                    ├── sprint tools (auto compound extract + trust decisions)
                                    ├── briefing tools (eval-opt: Haiku+Sonnet)
                                    ├── social tools (Sonnet + Radl brand context + withRetry)
                                    ├── monitoring tools (HTTP health checks)
                                    ├── team recipes (9 recipes)
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

13 hooks across 7 Claude Code lifecycle events. All quality gates fire automatically.

| Hook | Type | Event | Purpose |
|------|------|-------|---------|
| Full Context Restore | command | SessionStart | Re-injects sprint state, branch, patterns every session |
| Pre-Compact Save | command | PreCompact | Auto-checkpoints sprint state before compaction |
| Risk Classifier | command | PreToolUse (Bash) | Classifies commit risk by files touched |
| Sprint Guard | command | PreToolUse (Bash) | Warns if committing without active sprint |
| Push Pre-Flight | command | PreToolUse (Bash) | Runs pre_flight_check before git push |
| Branch Guard | command | PreToolUse (Bash) | Blocks pushes to main/master |
| Typecheck After Edit | command | PostToolUse (Edit/Write) | Runs tsc after editing .ts/.tsx files |
| Commit Spot-Check | command | PostToolUse (Bash) | AI spot-check of committed diffs |
| Post-Commit Verify | command | PostToolUse (Bash) | Verifies commit quality post-commit |
| Task Review Detector | agent | TaskCompleted | Inspects git diff for new patterns, recommends review |
| Session Verify | agent | Stop | Verifies STATE.md updated, sprint tracked, no uncommitted changes |
| Session Stop | command | Stop | Final session cleanup |
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

## Intelligence Architecture (Phase 80)

### Sprint Conductor Pipeline
1. **Knowledge loading** — patterns, lessons, deferred items, estimation calibration
2. **Eval-opt spec** — Sonnet generates, Opus evaluates (quality threshold 8/10)
3. **Haiku decomposition** — forced `tool_use` for structured task output
4. **Inverse bloom** — enriches tasks with time-decay weighted knowledge (30-day half-life)
5. **Speculative validation** — 5 zero-cost pre-checks against knowledge base
6. **Step checkpointing** — SHA256 feature hash enables resume after context loss
7. **Plan save** — traceability report matches commits to planned tasks at `sprint_complete`

### Closed-Loop Feedback
- `sprint_complete` auto-records trust decisions: estimation accuracy, bloom quality, validation warning follow-up
- `sprint_complete` auto-extracts causal pairs and records cognitive calibration
- Antibodies increment `catches` when matched during speculative validation
- Crystallized checks increment `catches` when matched
- Validation warnings are compared at sprint end: FIXED/PARTIAL/OPEN/REVIEW, recorded as `speculative_validation` trust domain

### Knowledge Search
- FTS5 BM25 hybrid search via `better-sqlite3` (src/knowledge/fts-index.ts)
- Embedding-ready interface for future vector similarity
- Time-decay scoring: 30-day half-life for inverse bloom relevance

### Agent Patterns
- **Antfarm pattern**: Read-only agents with KEY:VALUE structured output (see `~/.claude/agents/*-readonly.md`)
- **Task verification**: verify → parse → retry loop with criteria injection
- **Agent output parser**: Extracts KEY:VALUE pairs from structured agent responses

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

<!-- AUTO-MANAGED: Recent Changes -->
<!-- This section is automatically updated by the auto-memory plugin -->
<!-- DO NOT edit between these markers manually -->
<!-- /AUTO-MANAGED -->
