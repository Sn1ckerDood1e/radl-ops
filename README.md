# radl-ops

MCP server that turns [Claude Code](https://claude.com/claude-code) into an autonomous engineering system. Instead of manually running quality checks, tracking sprints, and coordinating reviews, radl-ops automates the entire development lifecycle through tools, hooks, and skills.

Built for [Radl](https://github.com/Sn1ckerDood1e/Radl) (rowing team management SaaS), but the patterns are transferable to any project using Claude Code.

## What It Does

**Layer 1: MCP Tools (Intelligence)** - 26 tools across 3 groups providing sprint management, AI-powered task decomposition, compound learning extraction, code drift detection, and zero-cost verification.

**Layer 2: Hooks (Enforcement)** - 10 hooks across 7 Claude Code lifecycle events. Every quality gate fires automatically: sprint tracking, branch protection, typecheck after edit, pre-push verification, build self-healing.

**Layer 3: Skills (Autonomous Workflows)** - `/sprint-execute` chains everything into a single command: research, spec, decompose, branch, implement, review, PR, learn. Human approves the spec; everything else is automated.

## Architecture

```
Claude Code <--(stdio/JSON-RPC)--> radl-ops MCP Server (v2.0.0)
                                    |
                                    +-- 26 tools (3 groups: core, content, advanced)
                                    +-- 3 resources (sprint state, iron laws, tool groups)
                                    +-- 3 prompts (sprint-start, sprint-review, code-review)
                                    +-- Sprint conductor (knowledge -> eval-opt spec -> decompose -> plan)
                                    +-- Eval-opt pattern (generator/critic loops with quality thresholds)
                                    +-- Compound learning (4-stage Bloom pipeline extraction)
                                    +-- Data flow verifier (zero-cost field lifecycle check)
                                    +-- Pre-flight check (zero-cost pre-push verification)
                                    +-- Drift detection (verify code against knowledge base)
                                    +-- Per-sprint cost tracking with daily log rotation
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Claude Code CLI
- Anthropic API key

### Setup

```bash
git clone https://github.com/Sn1ckerDood1e/radl-ops.git
cd radl-ops
npm install
cp .env.example .env
# Edit .env with your API keys
```

### Register as MCP Server

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "radl-ops": {
      "command": "npx",
      "args": ["tsx", "/path/to/radl-ops/src/mcp/server.ts"],
      "env": {
        "RADL_OPS_MODE": "mcp"
      }
    }
  }
}
```

### Verify

```bash
npm run typecheck   # Type checking
npm run test        # 371 tests
```

## MCP Tools

### Tool Groups (Dynamic Loading)

| Group | Default | Tools |
|-------|---------|-------|
| **core** | Enabled | sprint management, health check, iron laws, cost report, knowledge query, verify patterns, team recipes, audit triage, sprint advisor, review pipeline, sprint decompose, sprint conductor, verify data flow, pre-flight check |
| **content** | Disabled | daily/weekly briefings, social content tools, roadmap ideas |
| **advanced** | Disabled | eval-opt content generation, compound learning extraction |

Enable disabled groups at runtime:
```
mcp__radl-ops__enable_tools({ group: "content", action: "enable" })
```

### Key Tools

| Tool | Cost | Description |
|------|------|-------------|
| `sprint_conductor` | ~$0.15 | Full sprint orchestration: knowledge loading, eval-opt spec, task decomposition, execution plan |
| `sprint_decompose` | ~$0.03 | AI-powered task breakdown with dependency DAG and file ownership |
| `verify_data_flow` | $0 | Check field wiring across Schema, Migration, Validation, API Handler, Client |
| `pre_flight_check` | $0 | Pre-push verification: branch, sprint, clean tree, typecheck, secrets scan |
| `verify_patterns` | $0 | Detect code drift against knowledge base patterns |
| `compound_extract` | ~$0.05 | Extract reusable lessons via 4-stage Bloom pipeline |
| `review_pipeline` | ~$0.03 | Complete review workflow: recipe + triage template + orchestration |
| `sprint_start/progress/complete` | $0 | Sprint lifecycle management with Slack notifications |
| `health_check` | $0 | Aggregated Vercel/Supabase/GitHub status |
| `knowledge_query` | $0 | Query compound learnings (patterns, lessons, decisions) |

## Hooks

10 hooks across 7 Claude Code lifecycle events:

| Hook | Event | Purpose |
|------|-------|---------|
| Full Context Restore | SessionStart | Re-injects sprint state, branch, patterns every session |
| Pre-Compact Save | PreCompact | Auto-checkpoints sprint state before compaction |
| Risk Classifier | PreToolUse (Bash) | Classifies commit risk by files touched |
| Sprint Guard | PreToolUse (Bash) | Warns if committing without active sprint |
| Push Pre-Flight | PreToolUse (Bash) | Runs pre_flight_check before git push |
| Branch Guard | PreToolUse (Bash) | Blocks pushes to main/master |
| Typecheck After Edit | PostToolUse (Edit/Write) | Runs tsc after editing .ts/.tsx files |
| Task Review Detector | TaskCompleted | Inspects git diff for new patterns, recommends review |
| Session Verify | Stop | Verifies STATE.md updated, sprint tracked, no uncommitted changes |
| Build Self-Healer | PostToolUseFailure | Auto-diagnoses build/typecheck failures |

Hook scripts live in `scripts/hooks/`. Agent hooks are configured in Claude Code settings.

## Skills

### `/sprint-execute` - Autonomous Sprint

One command, full autonomous sprint:

```
/sprint-execute "Add practice attendance tracking"
```

Pipeline:
1. `sprint_conductor` generates quality-scored spec with task breakdown
2. Human reviews and approves the spec (only human touchpoint)
3. Creates feature branch and starts sprint tracking
4. Creates tasks with dependencies from conductor output
5. Spawns parallel agent teams for independent tasks
6. Each task: implement, typecheck, commit, review if new pattern
7. Final review: parallel code-reviewer + security-reviewer
8. Pre-flight check, push, create PR
9. Auto-extract compound learnings

## Iron Laws

Non-negotiable constraints enforced at every level:

1. Never push directly to `main` - always feature branches + PRs
2. Never delete production data
3. Never commit secrets (15 detection patterns)
4. Never modify CI/CD without explicit approval
5. Never change environment variables without explicit approval
6. After 3 failures on the same issue, STOP and escalate

## Knowledge System

radl-ops maintains a knowledge base that grows with every sprint:

- **patterns.json** - Reusable code patterns confirmed across multiple implementations
- **lessons.json** - Hard-won debugging insights and gotchas
- **decisions.json** - Architectural decisions with context and rationale
- **deferred.json** - Tech debt tracked for future resolution
- **compounds/** - AI-extracted learnings via Bloom taxonomy pipeline

Knowledge is automatically queried by `sprint_conductor` when planning new work, and by `verify_patterns` when checking code drift.

## Model Routing

Internal AI calls are routed to cost-appropriate models:

| Model | Use |
|-------|-----|
| Haiku | Briefing drafts, spot checks, Bloom understanding/rollout stages |
| Sonnet | Evaluator loops, social drafts, Bloom ideation/judgment stages |
| Opus | Roadmap ideation, deep architectural reasoning |

Cost tracking is per-sprint with daily log rotation.

## Project Structure

```
radl-ops/
  src/
    mcp/
      server.ts              # MCP server entry point (v2.0.0)
      tool-registry.ts       # Dynamic tool group management
      resources.ts           # MCP resources (sprint state, iron laws)
      prompts.ts             # MCP prompt templates
      tools/                 # 26 tool implementations + tests
        sprint.ts            # Sprint lifecycle management
        sprint-conductor.ts  # Full sprint orchestration pipeline
        sprint-decompose.ts  # AI task decomposition
        data-flow-verifier.ts # Zero-cost field lifecycle check
        pre-flight.ts        # Zero-cost pre-push verification
        drift-detection.ts   # Code drift against knowledge base
        eval-opt.ts          # Generator/critic quality loops
        compound.ts          # Bloom pipeline learning extraction
        ...
    models/
      router.ts              # Model routing (Haiku/Sonnet/Opus)
      token-tracker.ts       # Cost analytics with daily rotation
    patterns/
      evaluator-optimizer.ts # Eval-opt pattern implementation
      bloom-orchestrator.ts  # 4-stage Bloom taxonomy pipeline
    guardrails/
      iron-laws.ts           # Non-negotiable constraints
    config/                  # Logger, paths, Anthropic client
  scripts/
    hooks/                   # 10 hook scripts for Claude Code
    sprint.sh                # Sprint management CLI
    compound.sh              # Learning extraction CLI
    ...
  knowledge/                 # Compound learning data
  .claude/
    skills/                  # Autonomous workflow skills
    workflows/               # Workflow documentation
    rules/                   # Autonomy and monitoring rules
```

## Development

```bash
npm run test          # Run all tests (371)
npm run typecheck     # TypeScript checking
npm run mcp           # Start MCP server (for debugging)
```

## Future Roadmap

### Auto PR Merge
CI pipeline that auto-merges PRs when all checks pass (tests, typecheck, review approval). Currently PRs are created automatically but merged manually.

### Production Monitoring Feedback Loop
Deploy -> observe errors (Sentry) -> auto-create issues -> learn from fixes -> prevent recurrence. Close the loop between shipping and learning.

### Multi-Sprint Planning
Roadmap-level orchestration that sequences multiple sprints toward a milestone. Currently each sprint is planned independently; multi-sprint planning would optimize the order and parallelize across sprints.

### Adaptive Model Routing
Track which model produces the best results per task type and auto-adjust routing. Currently routing is static (Haiku for drafts, Sonnet for evaluation, Opus for reasoning).

## License

MIT
