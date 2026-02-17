# radl-ops

MCP server that turns [Claude Code](https://claude.com/claude-code) into an autonomous engineering system. Instead of manually running quality checks, tracking sprints, and coordinating reviews, radl-ops automates the entire development lifecycle through tools, hooks, and skills.

Built for [Radl](https://github.com/Sn1ckerDood1e/Radl) (rowing team management SaaS), but the patterns are transferable to any project using Claude Code.

## What It Does

**Layer 1: MCP Tools (Intelligence)** — 48 tools across 3 groups + 1 meta, providing sprint orchestration, closed-loop intelligence (antibodies, crystallization, causal graphs, speculative validation), compound learning extraction, zero-cost verification, and AI-powered task decomposition.

**Layer 2: Hooks (Enforcement)** — 10 hooks across 7 Claude Code lifecycle events. Every quality gate fires automatically: sprint tracking, branch protection, typecheck after edit, pre-push verification, build self-healing.

**Layer 3: Skills (Autonomous Workflows)** — `/sprint-execute` chains everything into a single command: research, spec, decompose, branch, implement, review, PR, learn. Human approves the spec; everything else is automated.

## Architecture

```
Claude Code <--(stdio/JSON-RPC)--> radl-ops MCP Server (v2.0.0)
                                    |
                                    +-- 48 tools (3 groups + 1 meta: core, content, advanced, meta)
                                    +-- 3 resources (sprint state, iron laws, tool groups)
                                    +-- 3 prompts (sprint-start, sprint-review, code-review)
                                    +-- Sprint conductor pipeline:
                                    |   +-- Knowledge loading (patterns, lessons, deferred, estimation)
                                    |   +-- Eval-opt spec (Sonnet generates, Opus evaluates)
                                    |   +-- Task decomposition (Haiku, forced tool_use)
                                    |   +-- Inverse bloom enrichment (time-decay weighted knowledge)
                                    |   +-- Speculative validation (5 zero-cost pre-checks)
                                    |   +-- Step-level checkpointing (SHA256 feature hash)
                                    |   +-- Plan traceability (commit-to-task matching)
                                    +-- Closed-loop intelligence:
                                    |   +-- Immune system (antibodies with chain matching)
                                    |   +-- Crystallization (promote lessons to automated checks)
                                    |   +-- Causal graphs (decision->outcome pairs with BFS)
                                    |   +-- Inverse bloom (30-day half-life knowledge injection)
                                    |   +-- Speculative validation (5 zero-cost pre-checks)
                                    |   +-- Cognitive load prediction (overflow forecasting)
                                    |   +-- Quality ratchet (trust tracking per domain)
                                    |   +-- Task verification (Antfarm verify-then-retry)
                                    |   +-- Validation follow-up (sprint_complete comparison)
                                    |   +-- Tool forge (Sonnet code gen from checks)
                                    |   +-- Counterfactual analysis (alternative outcome reasoning)
                                    +-- Knowledge infrastructure:
                                    |   +-- FTS5 BM25 search (better-sqlite3, embedding-ready)
                                    |   +-- MITRE ATLAS threat model (knowledge/threats.yaml)
                                    +-- Sprint tools (auto compound extract + trust decisions)
                                    +-- Briefing tools (eval-opt: Haiku+Sonnet)
                                    +-- Social tools (Sonnet + brand context + withRetry)
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
npm run test        # 801 tests
```

## MCP Tools

### Tool Groups (Dynamic Loading)

| Group | Default | Tools |
|-------|---------|-------|
| **core** | Enabled | sprint management, health check, iron laws, cost report, knowledge query, verify patterns, team recipes, audit triage, sprint advisor, review pipeline, sprint decompose, sprint conductor, verify data flow, pre-flight check, spot check diff, deferred triage, sprint retrospective, auto prioritize, spec to tests, crystallize (propose/approve/demote/list), antibody (create/list/disable), causal (extract/query), inverse bloom, trust (report/record), speculative validate, cognitive load |
| **content** | Disabled | daily/weekly briefings, social content tools, roadmap ideas |
| **advanced** | Disabled | eval-opt content generation, compound learning extraction, tool forge, counterfactual analysis |
| **meta** | Always | enable_tools (toggle groups at runtime) |

Enable disabled groups at runtime:
```
mcp__radl-ops__enable_tools({ group: "content", action: "enable" })
```

### Key Tools

| Tool | Cost | Description |
|------|------|-------------|
| `sprint_conductor` | ~$0.15 | Full sprint orchestration: knowledge → eval-opt spec → decompose → inverse bloom → speculative validate → checkpointed plan |
| `sprint_decompose` | ~$0.03 | AI-powered task breakdown with dependency DAG and file ownership |
| `speculative_validate` | $0 | Pre-validate tasks against antibodies, crystallized checks, causal graph, data flow coverage |
| `verify_data_flow` | $0 | Check field wiring across Schema → Migration → Validation → API Handler → Client |
| `pre_flight_check` | $0 | Pre-push verification: branch, sprint, clean tree, typecheck, secrets scan |
| `inverse_bloom` | $0 | Inject time-decay weighted knowledge into task descriptions |
| `cognitive_load` | $0 | Predict context window overflow with calibration data |
| `verify_patterns` | $0 | Detect code drift against knowledge base patterns |
| `compound_extract` | ~$0.05 | Extract reusable lessons via 4-stage Bloom pipeline |
| `sprint_complete` | $0* | Complete sprint, auto-extract learnings, record trust decisions, compare validation warnings |

\* sprint_complete itself is $0 but triggers Bloom pipeline (~$0.05) and causal extraction (~$0.01) if auto_extract is enabled.

## Hooks

10 hooks across 7 Claude Code lifecycle events:

| Hook | Event | Purpose |
|------|-------|---------|
| Full Context Restore | SessionStart | Re-injects sprint state, branch, patterns, antibodies every session |
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

### `/sprint-execute` — Autonomous Sprint

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
9. Auto-extract compound learnings + record trust decisions

## Closed-Loop Intelligence

radl-ops learns from every sprint and applies that knowledge to future work:

```
Sprint N                          Sprint N+1
  |                                  |
  +-- Bloom extract lessons     +-- Conductor loads knowledge
  +-- Causal extract pairs      +-- Inverse bloom injects warnings
  +-- Trust record decisions    +-- Speculative validate pre-checks
  +-- Antibodies from bugs      +-- Antibodies block repeat bugs
  +-- Crystallize patterns      +-- Crystallized checks auto-run
  +-- Cognitive calibration     +-- Load prediction calibrated
  |                                  |
  +-- Validation warnings  -->  +-- Follow-up at sprint_complete
```

### Systems

| System | Purpose | Cost |
|--------|---------|------|
| **Immune System** | Antibodies from bugs prevent recurrence. Chain matching for related patterns. | $0.01/create |
| **Crystallization** | Promote high-frequency lessons to automated checks. Propose/approve/demote lifecycle. | $0.01/propose |
| **Causal Graphs** | Extract decision→outcome pairs. BFS traversal for related chains. | $0.01/extract |
| **Inverse Bloom** | Inject knowledge into task descriptions. 30-day half-life time decay. | $0 |
| **Speculative Validation** | 5 pre-checks: data flow, antibodies, crystallized, genome, causal. | $0 |
| **Quality Ratchet** | Trust tracking per domain. Success/override rates. False positive monitoring. | $0 |
| **Cognitive Load** | Context window overflow prediction with sprint-level calibration. | $0 |
| **Tool Forge** | Generate MCP tool code from crystallized checks or antibodies. | ~$0.05/gen |
| **Counterfactual Analysis** | "What if" reasoning about alternative sprint outcomes. | ~$0.05/analysis |

## Iron Laws

Non-negotiable constraints enforced at every level:

1. Never push directly to `main` — always feature branches + PRs
2. Never delete production data
3. Never commit secrets (15 detection patterns)
4. Never modify CI/CD without explicit approval
5. Never change environment variables without explicit approval
6. After 3 failures on the same issue, STOP and escalate

## Knowledge System

radl-ops maintains a knowledge base that grows with every sprint:

- **patterns.json** — Reusable code patterns confirmed across multiple implementations
- **lessons.json** — Hard-won debugging insights and gotchas
- **decisions.json** — Architectural decisions with context and rationale
- **deferred.json** — Tech debt tracked for future resolution
- **compounds/** — AI-extracted learnings via Bloom taxonomy pipeline
- **antibodies.json** — Bug patterns that must never recur
- **crystallized.json** — Lessons promoted to automated checks
- **causal-graph.json** — Decision→outcome pairs for causal reasoning
- **trust-ledger.json** — Trust decisions per domain (estimation, bloom, validation)
- **threats.yaml** — MITRE ATLAS threat model for security reasoning

Knowledge is automatically queried by `sprint_conductor` when planning, injected via `inverse_bloom` into task descriptions, and validated via `speculative_validate` before execution.

## Model Routing

Internal AI calls are routed to cost-appropriate models:

| Model | Use |
|-------|-----|
| Haiku | Briefing drafts, spot checks, social ideas, antibody/crystallize creation, Bloom understanding/rollout stages, task decomposition |
| Sonnet | Evaluator loops, social drafts/calendar, tool forge, Bloom ideation/judgment stages |
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
      tools/                 # 48 tool implementations + tests
        sprint.ts            # Sprint lifecycle (auto trust + validation follow-up)
        sprint-conductor.ts  # Full sprint orchestration pipeline
        sprint-decompose.ts  # AI task decomposition
        immune-system.ts     # Antibodies with chain matching
        crystallization.ts   # Lesson promotion lifecycle
        causal-graph.ts      # Decision-outcome pairs
        inverse-bloom.ts     # Time-decay knowledge injection
        speculative-validate.ts  # 5 zero-cost pre-checks
        quality-ratchet.ts   # Trust tracking per domain
        cognitive-load.ts    # Context overflow prediction
        tool-forge.ts        # Code generation from checks
        counterfactual.ts    # Alternative outcome reasoning
        data-flow-verifier.ts # Zero-cost field lifecycle check
        pre-flight.ts        # Zero-cost pre-push verification
        shared/              # Shared utilities
          task-verifier.ts   # Antfarm verify-then-retry protocol
          agent-output-parser.ts  # KEY:VALUE structured output parsing
          conductor-checkpoint.ts # SHA256 feature hash checkpointing
          plan-store.ts      # Plan traceability + commit matching
        ...
    knowledge/
      fts-index.ts           # FTS5 BM25 search (better-sqlite3)
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
  knowledge/                 # Compound learning data + threat model
  .claude/
    skills/                  # Autonomous workflow skills
    workflows/               # Workflow documentation
    rules/                   # Autonomy and monitoring rules
```

## Development

```bash
npm run test          # Run all tests (801)
npm run typecheck     # TypeScript checking
npm run mcp           # Start MCP server (for debugging)
```

## Future Roadmap

### Auto PR Merge
CI pipeline that auto-merges PRs when all checks pass (tests, typecheck, review approval). Currently PRs are created automatically but merged manually.

### Production Monitoring Feedback Loop
Deploy → observe errors (Sentry) → auto-create issues → learn from fixes → prevent recurrence. Close the loop between shipping and learning.

### Multi-Sprint Planning
Roadmap-level orchestration that sequences multiple sprints toward a milestone. Currently each sprint is planned independently; multi-sprint planning would optimize the order and parallelize across sprints.

### Adaptive Model Routing
Track which model produces the best results per task type and auto-adjust routing. Currently routing is static (Haiku for drafts, Sonnet for evaluation, Opus for reasoning).

### Embedding-Based Knowledge Search
Upgrade FTS5 BM25 search with vector embeddings for semantic similarity. The FTS5 interface is already embedding-ready — needs a vector store and embedding model integration.

## License

MIT
