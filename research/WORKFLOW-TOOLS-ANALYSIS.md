# Claude Code Workflow Tools Analysis

**Date:** 2026-02-04
**Purpose:** Evaluate existing tools to build a custom Radl workflow

## Tools Evaluated

| Tool | Stars | Focus | Complexity |
|------|-------|-------|------------|
| [GSD](https://github.com/glittercowboy/get-shit-done) | High | Spec-driven development | High |
| [everything-claude-code](https://github.com/affaan-m/everything-claude-code) | Medium | Agent delegation + learning | Medium |
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | Medium | Autonomous execution modes | Low |
| [wshobson/agents](https://github.com/wshobson/agents) | High | Granular plugin architecture | High |

---

## GSD (get-shit-done-cc)

**Philosophy:** "The complexity is in the system, not in your workflow."

### What It Does Well

| Strength | Why It Matters |
|----------|----------------|
| **Context rot solution** | Each plan runs in fresh 200k token subagent |
| **Atomic git commits** | Every task revertable, bisect-friendly |
| **Requirement tracking** | REQ-IDs link features to verification |
| **Plan verification** | `gsd-plan-checker` validates before execution |
| **Milestone management** | Clear phase → milestone → version progression |
| **State persistence** | STATE.md survives context resets |

### What It Does Poorly

| Weakness | Impact |
|----------|--------|
| **Heavy file ceremony** | 4-5 files per phase (CONTEXT, PLAN, SUMMARY, VERIFICATION) |
| **Many user prompts** | 5-10 interactions per phase |
| **Token overhead** | Always loads PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md |
| **15+ commands** | Learning curve, decision fatigue |
| **Overkill for small tasks** | `/gsd:quick` exists but still creates files |

### Best For
- Greenfield projects with unclear requirements
- Teams needing documentation trail
- Complex multi-phase features

---

## everything-claude-code

**Philosophy:** "Battle-tested configs from an Anthropic hackathon winner."

### What It Does Well

| Strength | Why It Matters |
|----------|----------------|
| **Simple commands** | `/plan`, `/tdd`, `/code-review`, `/build-fix` |
| **Continuous learning** | Instincts extracted from sessions, evolve into skills |
| **Cross-platform** | Node.js scripts work on Windows/macOS/Linux |
| **Token optimization** | System prompt slimming, smart model selection |
| **Hooks automation** | Events trigger background processes |
| **Skill generation** | `/skill-create` learns from your git history |

### What It Does Poorly

| Weakness | Impact |
|----------|--------|
| **No project state** | No STATE.md equivalent, context lost on reset |
| **No requirement tracking** | Can't verify "did we ship what we planned?" |
| **Plugin limitation** | Rules can't be distributed (upstream issue) |
| **CLI version dependency** | Requires v2.1.0+ |

### Best For
- Experienced devs who know what they want
- Projects with existing patterns to learn from
- Quick iterations without ceremony

---

## oh-my-claudecode

**Philosophy:** "Don't learn Claude Code. Just use OMC."

### What It Does Well

| Strength | Why It Matters |
|----------|----------------|
| **Zero configuration** | Works out of the box |
| **Natural language** | "autopilot: build X" instead of commands |
| **5 execution modes** | Autopilot, Ultrapilot, Ralph, Swarm, Ecomode |
| **Smart model routing** | Haiku for simple, Sonnet for medium, Opus for complex |
| **Persistent execution** | "Ralph" mode won't stop until verified complete |
| **30-50% token savings** | Ecomode for budget-conscious execution |

### Execution Modes Explained

| Mode | Use Case | Parallelism |
|------|----------|-------------|
| **Autopilot** | Full autonomous, detect intent | Sequential |
| **Ultrapilot** | Multi-component systems | 3-5x parallel |
| **Ralph** | Must complete no matter what | Persistent retry |
| **Swarm** | Coordinated multi-agent | Distributed |
| **Ecomode** | Token budget constraints | Optimized |

### What It Does Poorly

| Weakness | Impact |
|----------|--------|
| **No failure mode docs** | Hard to debug when things go wrong |
| **tmux dependency** | Rate-limit utility needs tmux |
| **Too magic** | Hard to understand what it's doing |
| **No verification step** | How do you know it actually works? |

### Best For
- Rapid prototyping
- Well-defined tasks with clear completion criteria
- Users who hate memorizing commands

---

## wshobson/agents

**Philosophy:** "Install only what you need."

### What It Does Well

| Strength | Why It Matters |
|----------|----------------|
| **Granular plugins** | 72 plugins, avg 3.4 components each |
| **108 specialized agents** | Deep domain expertise |
| **Three-tier model** | Opus/Sonnet/Haiku based on task complexity |
| **Progressive disclosure** | Skills load in tiers (metadata → instructions → resources) |
| **Multi-agent workflows** | Predefined orchestrations (fullstack, security, etc.) |
| **MIT licensed** | Can fork and customize |

### What It Does Poorly

| Weakness | Impact |
|----------|--------|
| **Scale complexity** | 72 plugins is overwhelming |
| **Skill activation vague** | Unclear when skills load |
| **Plugin interdependency** | Workflows need multiple plugins but coordination unclear |
| **Claude-specific** | Vendor lock-in |

### Best For
- Large teams with specialized roles
- Enterprise projects needing granular control
- Users who want to compose their own toolchain

---

## Comparison Matrix

| Feature | GSD | everything-claude-code | oh-my-claudecode | wshobson/agents |
|---------|-----|------------------------|------------------|-----------------|
| **State persistence** | ✅ STATE.md | ❌ None | ❌ None | ❌ None |
| **Requirement tracking** | ✅ REQ-IDs | ❌ No | ❌ No | ❌ No |
| **Verification step** | ✅ Explicit | ⚠️ Code review only | ❌ No | ⚠️ Workflow-dependent |
| **Autonomous execution** | ⚠️ With approval | ⚠️ Semi | ✅ Full | ⚠️ Workflow-dependent |
| **Token efficiency** | ❌ Heavy | ✅ Optimized | ✅ Ecomode | ✅ Progressive |
| **Learning curve** | ❌ High | ✅ Low | ✅ Very low | ❌ High |
| **Context survival** | ✅ Files | ❌ Lost | ❌ Lost | ❌ Lost |
| **Parallel execution** | ✅ Waves | ⚠️ Manual | ✅ Ultrapilot | ✅ Workflows |
| **Build mode focus** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Maintain mode** | ❌ No | ⚠️ Partial | ❌ No | ⚠️ Partial |

---

## Key Insights

### What We Must Keep (from GSD)
1. **STATE.md** - Single source of truth that survives context resets
2. **Atomic commits** - Every change revertable
3. **Verification checkpoint** - Know when things actually work
4. **Requirement tracking** - ROADMAP.md checkboxes at minimum

### What We Should Adopt (from everything-claude-code)
1. **Simple commands** - `/sprint` not `/gsd:execute-phase`
2. **Agent delegation** - Let specialized agents do the work
3. **Continuous learning** - Instincts for pattern extraction

### What We Should Try (from oh-my-claudecode)
1. **Natural language triggers** - "sprint on X" not "/sprint X"
2. **Smart model routing** - Haiku for simple, Sonnet for complex
3. **Persistent mode** - Don't stop until verified

### What We Should Avoid
1. **Heavy file ceremony** - No CONTEXT.md, PLAN.md, SUMMARY.md per phase
2. **15+ commands** - 5 commands max for build mode
3. **Too much magic** - Need to understand what's happening
4. **Zero state** - Must survive context resets

---

## Radl-Specific Requirements

| Requirement | Rationale |
|-------------|-----------|
| **Production quality** | 163k LOC, real users expected |
| **Solo founder** | Can't afford debugging magic |
| **Spring deadline** | March 2026 for LRC/CJR beta |
| **Two modes** | BUILD now, MAINTAIN later |
| **Minimal input** | 1-2 prompts per sprint, not 5-10 |
| **Context survival** | STATE.md must persist across resets |

---

## Recommendation

**Hybrid approach combining:**
- GSD's state management (STATE.md, ROADMAP.md checkboxes)
- everything-claude-code's simple commands (/sprint, /verify)
- oh-my-claudecode's natural language + smart model routing
- Custom verification checkpoint (not full GSD ceremony)

**Two distinct workflows:**
1. **BUILD mode** - For v4.0 development, sprint-based
2. **MAINTAIN mode** - For post-launch, issue-driven

---

## Sources

- [GSD - glittercowboy/get-shit-done](https://github.com/glittercowboy/get-shit-done)
- [everything-claude-code - affaan-m](https://github.com/affaan-m/everything-claude-code)
- [oh-my-claudecode - Yeachan-Heo](https://github.com/Yeachan-Heo/oh-my-claudecode)
- [wshobson/agents](https://github.com/wshobson/agents)
- [awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)
- [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)
