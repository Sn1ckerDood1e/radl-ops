# AI Assistant Research for Radl Ops

A comprehensive analysis of similar projects to inform how we build Radl Ops for managing the Radl SaaS business.

## Executive Summary

| Project | Status | Best For | Security Model | Relevance to Radl Ops |
|---------|--------|----------|----------------|----------------------|
| **OpenClaw** | Active, 100k+ stars | General-purpose agent | Weak (opt-in sandbox) | Architecture patterns, skill system |
| **Leon** | Rewrite in progress | Personal assistant | Moderate (local-first) | Modular skill design |
| **Mycroft/OVOS** | Community fork | Voice-first | Strong (offline-first) | Privacy patterns |
| **Rhasspy** | Active | Home automation | Strong (fully offline) | Isolation architecture |
| **Zuckerberg's Jarvis** | Private | Smart home | Tied to FB infra | Context-awareness patterns |

**Key Takeaway**: OpenClaw's rapid rise (and security disasters) shows strong demand but also what NOT to do. Radl Ops should prioritize security-by-default, not opt-in sandboxing.

---

## 1. OpenClaw (formerly Moltbot/Clawdbot)

### Overview

OpenClaw is an open-source autonomous AI agent that exploded in popularity, gaining 100k+ GitHub stars within 2 months. Originally named "Clawdbot," it was renamed twice after trademark issues.

**Creator**: Peter Steinberger
**License**: MIT
**GitHub**: [openclaw/openclaw](https://github.com/openclaw/openclaw)

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Gateway                          │
│  (Background service, manages platform connections) │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                    Agent                            │
│  (LLM reasoning engine - Claude, GPT, etc.)         │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                   Skills                            │
│  (Modular capabilities: browser, files, calendar)   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                   Memory                            │
│  (Markdown files for context & preferences)         │
└─────────────────────────────────────────────────────┘
```

### What They Do Well

1. **Multi-Channel Inbox**: Connects to 10+ platforms (WhatsApp, Telegram, Slack, Discord, Signal, Teams, Matrix)
2. **Skill Marketplace (ClawHub)**: Agent can auto-discover and install new skills
3. **Persistent Memory**: Long-term context retention across sessions
4. **Proactive Behavior**: Can reach out with reminders and insights
5. **Self-Hosted**: Runs on Mac, Linux, Windows WSL2, Raspberry Pi

### Security Concerns (CRITICAL)

OpenClaw has become a **security nightmare**:

1. **Supply Chain Attacks**: 341 malicious skills found on ClawHub, stealing crypto keys, passwords, SSH credentials
2. **Prompt Injection**: System prompt guardrails are "soft guidance only"
3. **RCE Vulnerability**: One-click remote code execution via malicious links (Feb 2026)
4. **Excessive Privileges**: Can run shell commands, read/write files, execute scripts
5. **No Mandatory Sandboxing**: Sandboxing is opt-in, not default

**Cisco's assessment**: "An absolute nightmare"
**Palo Alto Networks**: "Lethal trifecta" - private data access + untrusted content exposure + external comms with memory

### Lessons for Radl Ops

✅ **Adopt**: Multi-channel architecture, skill modularity, persistent memory
❌ **Avoid**: Open skill marketplace, opt-in security, excessive permissions
🔒 **Improve**: Mandatory sandboxing, curated skills only, approval workflows

---

## 2. Leon AI

### Overview

Leon is an open-source personal assistant undergoing a major rewrite to become an "agentic" system. It's transitioning from standard assistant to autonomous AI.

**Website**: [getleon.ai](https://getleon.ai)
**GitHub**: [leon-ai/leon](https://github.com/leon-ai/leon)
**License**: MIT

### Architecture (New Design)

```
Skills → Actions → Tools → Functions → Binaries
```

Instead of monolithic scripts, Leon uses atomic components. Example: A "Video Translator" skill orchestrates:
- Vocal isolation tool
- Zero-shot voice cloning
- ASR (speech recognition)
- Audio gender recognition

### What They Do Well

1. **Meta-Skill Development**: Leon can write code for new skills automatically
2. **Hybrid NLP**: Balances LLM, classification, and traditional NLP for speed
3. **Modular TTS/STT**: Pluggable speech engines
4. **Privacy-First**: You control your data, runs on your server
5. **Transformer Integration**: Modern ML models for intent understanding

### Security Concerns

- Currently in experimental rewrite (unstable)
- Less scrutinized than OpenClaw (smaller attack surface, but also less security review)

### Lessons for Radl Ops

✅ **Adopt**: Atomic skill composition, meta-skill generation concept
✅ **Adopt**: Hybrid approach (LLM + traditional methods for speed)
⚠️ **Monitor**: Wait for stable release before borrowing patterns

---

## 3. Mycroft AI / OpenVoiceOS

### Overview

Mycroft was an open-source voice assistant that ceased development in 2023 due to a patent troll lawsuit. The community continues via **OpenVoiceOS (OVOS)**.

**Successor**: [OpenVoiceOS](https://openvoiceos.com)
**License**: Apache 2.0

### Architecture

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Wake Word   │ → │     ASR      │ → │     NLU      │
│   (Precise)  │   │ (Whisper/    │   │   (Intent    │
│              │   │   Vosk)      │   │   Parsing)   │
└──────────────┘   └──────────────┘   └──────────────┘
                                              │
                                              ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│     TTS      │ ← │   Dialogue   │ ← │    Skill     │
│   (Piper/    │   │   Manager    │   │   Engine     │
│   Mimic)     │   │              │   │              │
└──────────────┘   └──────────────┘   └──────────────┘
```

### What They Do Well

1. **Fully Offline Processing**: All processing on-device, not cloud
2. **Privacy by Design**: Audio never leaves device unless explicitly configured
3. **Modular Components**: Swap ASR, TTS, wake word engines freely
4. **Low Latency**: ~500-900ms response times with Whisper + Piper
5. **GDPR/HIPAA Friendly**: No external data transmission

### Security Strengths

- No cloud dependency = no data exfiltration risk
- Open source = community security review
- Google requests proxied to hide user identity

### Lessons for Radl Ops

✅ **Adopt**: Privacy-first architecture, component modularity
✅ **Adopt**: Option for fully local processing
⚠️ **Consider**: Voice interface may be useful for quick briefings

---

## 4. Rhasspy

### Overview

Rhasspy is an offline private voice assistant focused on home automation integration, especially with Home Assistant.

**Website**: [rhasspy.readthedocs.io](https://rhasspy.readthedocs.io)
**GitHub**: [rhasspy/rhasspy](https://github.com/rhasspy/rhasspy)
**License**: MIT

### Architecture (v3 Wyoming Protocol)

```
All services communicate via Wyoming protocol (JSON Lines + binary payload)
Standard input/output = low barrier for new integrations
```

Separates:
- Wake word detection (ultra-low-power, always on)
- ASR (on-demand, heavier compute)
- TTS (on-demand)

### What They Do Well

1. **100% Offline**: Zero internet dependency
2. **20+ Languages**: Broad international support
3. **Custom Wake Words**: Train your own
4. **Domain-Specific Grammars**: Define exact vocabulary
5. **Low Hardware Requirements**: Runs on $75 Raspberry Pi 5

### Security Strengths

- Network isolation by design
- No external API calls required
- Simple JSON-based protocol = auditable

### Lessons for Radl Ops

✅ **Adopt**: Wyoming protocol concept (simple, auditable IPC)
✅ **Adopt**: Satellite architecture (heavy processing on server, lightweight clients)
⚠️ **Limited**: Voice-only focus less relevant for text-based business ops

---

## 5. Zuckerberg's Jarvis

### Overview

A personal AI assistant Mark Zuckerberg built in 2016 to automate his home. Not open source, but instructive.

**Development Time**: 100-150 hours
**Voice**: Morgan Freeman

### Architecture

Built with Python, PHP, Objective C using:
- Natural language processing
- Speech recognition
- Face recognition
- Reinforcement learning

### What They Do Well

1. **Context Awareness**: "Turn up AC in my office" means different things for Mark vs Priscilla
2. **Multi-Modal**: Voice + text (Messenger bot) + iOS app
3. **Personalization**: Learned tastes in music, routines
4. **Integration Breadth**: Sonos, Samsung TV, Nest, custom toaster

### Key Insight

> "When Jarvis communicates with me, I'd much rather receive that over text message than voice. Future AI products cannot be solely focused on voice and will need a private messaging interface as well."

### Challenges Faced

- No common API standards between devices
- Home network security constraints
- Context disambiguation between users

### Lessons for Radl Ops

✅ **Adopt**: Multi-modal interface (Slack text + Email + CLI)
✅ **Adopt**: Strong context awareness
✅ **Adopt**: Personalization over time

---

## 6. Security Best Practices for AI Agents (2025)

Based on industry research and the OpenClaw security disasters:

### Mandatory Controls

| Control | Implementation |
|---------|----------------|
| **Least Privilege** | Agent only gets minimum permissions needed |
| **Short-Lived Tokens** | 300-second tokens (92% reduction in credential theft) |
| **Network Egress Control** | Allowlist external API calls |
| **Sandboxed Execution** | Container/VM isolation for tool execution |
| **Approval Workflows** | Human-in-the-loop for sensitive actions |
| **No Embedded Secrets** | Store in Vault/KMS, never in prompts |

### Threat Prioritization (OWASP 2025)

1. **Prompt Injection** (#1 risk) - Especially indirect injection via external data
2. **Supply Chain Attacks** - Malicious skills/plugins
3. **Credential Theft** - Exposed API keys, tokens
4. **Data Exfiltration** - Agent sending data to attackers
5. **Privilege Escalation** - Agent gaining unauthorized access

### Sandboxing Options

| Technology | Use Case | Isolation Level |
|------------|----------|-----------------|
| **gVisor/GKE Sandbox** | Untrusted code in K8s | Strong |
| **Firecracker microVMs** | Maximum isolation | Very Strong |
| **WASI** | Plugin capability scoping | Moderate |
| **seccomp + namespaces** | Container hardening | Moderate |

### Container Hardening Checklist

- [ ] Seccomp profiles filtering syscalls
- [ ] Drop CAP_SYS_ADMIN capability
- [ ] User namespace remapping
- [ ] Read-only root filesystem
- [ ] Network policy restrictions

---

## Recommendations for Radl Ops

### 1. Security Architecture (CRITICAL)

```
┌─────────────────────────────────────────────────────────┐
│                  Radl Ops Core                          │
│         (Hardened, minimal permissions)                 │
└─────────────────────┬───────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         │            │            │
         ▼            ▼            ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│   GitHub    │ │   Slack     │ │   Email     │
│   (Scoped   │ │   (Read +   │ │   (Send     │
│    Token)   │ │   Write)    │ │    Only)    │
└─────────────┘ └─────────────┘ └─────────────┘

┌─────────────────────────────────────────────────────────┐
│              Tool Execution Sandbox                     │
│   (Isolated container, no network egress by default)   │
└─────────────────────────────────────────────────────────┘
```

### 2. Permission Tiers

| Tier | Actions | Approval |
|------|---------|----------|
| **Read** | List issues, get stats, read code | Automatic |
| **Create** | Create issues, draft posts | Automatic |
| **Modify** | Update issues, merge PRs | Requires approval |
| **Delete** | Close issues, delete branches | Always requires approval |
| **External** | Post to social media, send emails | Always requires approval |

### 3. What to Borrow

| From | Pattern | Priority |
|------|---------|----------|
| OpenClaw | Skill registry system | High |
| OpenClaw | Multi-channel messaging | High |
| OpenClaw | Persistent memory (Markdown) | Medium |
| Leon | Atomic skill composition | Medium |
| Mycroft/OVOS | Component modularity | Medium |
| Rhasspy | Simple IPC protocol | Low |
| Jarvis | Context awareness | High |
| Jarvis | Multi-modal (text preferred) | High |

### 4. What to Avoid

| Anti-Pattern | Why | Alternative |
|--------------|-----|-------------|
| Open skill marketplace | Supply chain attacks | Curated, audited skills only |
| Opt-in sandboxing | Too easy to skip | Mandatory sandboxing |
| Embedded credentials | Prompt injection exposure | Vault/KMS with short-lived tokens |
| Unlimited network access | Data exfiltration | Egress allowlist |
| Auto-execute external code | RCE risk | Human approval for new code |

### 5. Radl Ops Specific Recommendations

Given Radl Ops will manage:
- **Feature planning** → Read-only GitHub access + ability to create issues (low risk)
- **Social media** → High risk, always require approval
- **Briefings** → Read aggregation, low risk
- **Code assistance** → Dangerous if auto-executing, require approval for PRs

**Suggested Default Permissions:**

```typescript
const DEFAULT_PERMISSIONS = {
  github: {
    read: true,         // List issues, PRs, stats
    createIssue: true,  // Create new issues
    comment: true,      // Comment on issues
    createPR: false,    // Requires approval
    mergePR: false,     // Requires approval
  },
  slack: {
    read: true,
    respond: true,
    initiate: false,    // Don't spam user
  },
  email: {
    sendBriefing: true, // Scheduled, expected
    sendOther: false,   // Requires approval
  },
  social: {
    draft: true,        // Can draft posts
    post: false,        // Always requires approval
  },
};
```

---

## Sources

### OpenClaw/Moltbot
- [CNBC - From Clawdbot to Moltbot to OpenClaw](https://www.cnbc.com/2026/02/02/openclaw-open-source-ai-agent-rise-controversy-clawdbot-moltbot-moltbook.html)
- [Cisco - Personal AI Agents Are a Security Nightmare](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
- [The Hacker News - 341 Malicious ClawHub Skills](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html)
- [VentureBeat - OpenClaw Security Risk Guide](https://venturebeat.com/security/openclaw-agentic-ai-security-risk-ciso-guide)
- [OpenClaw Official Docs](https://docs.openclaw.ai/gateway/security)

### Leon AI
- [Leon Official Website](https://getleon.ai/)
- [Leon GitHub](https://github.com/leon-ai/leon)
- [Leon Architecture Docs](https://docs.getleon.ai/architecture)

### Mycroft/OpenVoiceOS
- [OpenSource.com - Securing Privacy with Mycroft](https://opensource.com/article/19/2/mycroft-voice-assistant)
- [Mycroft Wikipedia](https://en.wikipedia.org/wiki/Mycroft_(software))
- [Skywork - Mycroft vs OpenAI Realtime API 2025](https://skywork.ai/blog/agent/open-source-voice-agents-mycroft-vs-openai-realtime-api-2025/)

### Rhasspy
- [Rhasspy Documentation](https://rhasspy.readthedocs.io/)
- [Rhasspy GitHub](https://github.com/rhasspy/rhasspy)

### Zuckerberg's Jarvis
- [Fast Company - At Home With Zuckerberg and Jarvis](https://www.fastcompany.com/3066478/mark-zuckerberg-jarvis)
- [TIME - Mark Zuckerberg on Making His AI Butler](https://time.com/4606721/mark-zuckerberg-ai-butler-jarvis-2016/)

### Security Best Practices
- [NVIDIA - Sandboxing Agentic Workflows](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- [Rippling - Agentic AI Security Guide 2025](https://www.rippling.com/blog/agentic-ai-security)
- [Glean - Best Practices for AI Agent Security 2025](https://www.glean.com/perspectives/best-practices-for-ai-agent-security-in-2025)
- [Obsidian Security - Security for AI Agents 2025](https://www.obsidiansecurity.com/blog/security-for-ai-agents)
