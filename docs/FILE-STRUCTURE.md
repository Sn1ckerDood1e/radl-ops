# Radl File Structure

**Updated:** 2026-02-05

## Source of Truth

All planning lives in one place:

```
/home/hb/radl/.planning/
├── STATE.md              ← Current position (briefings read this)
├── ROADMAP.md            ← Phase breakdown (briefings read this)
├── PROJECT.md            ← Vision and shipped features
├── MILESTONES.md         ← Completed milestone summaries
├── PRICING-STRATEGY.md   ← Pricing tiers and competitor analysis
├── ONBOARDING-STRATEGY.md← Club profiles and feature flags
├── config.json           ← GSD config (if using GSD commands)
├── codebase/             ← Architecture and convention docs
├── intel/                ← Codebase intelligence (from /gsd:analyze)
├── milestones/           ← Detailed milestone archives
├── research/             ← Domain research
└── archive/              ← Historical docs (phases-v1-v3, old audits)
```

## Operations

Scripts, logs, and operational tools:

```
/home/hb/radl-ops/
├── CLAUDE.md             ← AI behavior rules
├── RADL-WORKFLOW.md      ← Workflow documentation
├── .env                  ← Secrets (Slack webhooks, etc.)
├── scripts/
│   ├── daily-briefing.sh ← Mon-Fri 7am
│   └── weekly-briefing.sh← Saturday 7am
├── briefings/            ← Generated briefing files
├── logs/                 ← Session logs
├── research/             ← Tool/workflow research
└── docs/                 ← This file, guides
```

## Commands

Located in `~/.claude/commands/`:

### BUILD Mode (Daily Development)

| Command | Purpose |
|---------|---------|
| `/build` | Start sprint with quality gates |
| `/verify` | Check sprint output (build, lint, types, migrations, coverage) |
| `/fix` | Fix verification failures |
| `/status` | Show current position |
| `/pause` | Save context for later |

### MAINTAIN Mode (Production Support)

| Command | Purpose |
|---------|---------|
| `/triage` | Prioritize incoming issues |
| `/fix` | Fix specific issue |
| `/verify` | Same as BUILD |
| `/release` | Tag and deploy with E2E gate |
| `/hotfix` | Emergency P0/P1 production fix |
| `/rollback` | Revert bad deployment |

## Briefing Data Flow

```
Morning cron job
      │
      ▼
daily-briefing.sh
      │
      ├── Reads: /home/hb/radl/.planning/STATE.md
      ├── Reads: /home/hb/radl/.planning/ROADMAP.md
      │
      ▼
Generates briefing → Sends to Slack
      │
      ▼
You read briefing → Open Claude session
      │
      ▼
/build [feature from briefing]
      │
      ▼
/verify → Updates STATE.md
      │
      ▼
Next morning → Briefing reads updated STATE.md
```

## Key Files

| File | Purpose | Read by |
|------|---------|---------|
| `STATE.md` | Current position, sprint log, blockers | Briefings, /status, /build |
| `ROADMAP.md` | Phase breakdown, checkboxes | Briefings, /build |
| `PROJECT.md` | Vision, shipped features | Reference only |
| `RADL-WORKFLOW.md` | How the workflow works | Reference only |
