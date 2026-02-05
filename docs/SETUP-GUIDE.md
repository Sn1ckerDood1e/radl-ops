# Radl Ops - Complete Setup Guide

A step-by-step guide to set up your autonomous AI assistant for managing the Radl business.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Decision](#architecture-decision)
3. [Prerequisites](#prerequisites)
4. [Account Setup](#account-setup)
5. [API Keys & Credentials](#api-keys--credentials)
6. [Slack App Setup](#slack-app-setup)
7. [GitHub Integration](#github-integration)
8. [Email Setup (Resend)](#email-setup-resend)
9. [Security Configuration](#security-configuration)
10. [Deployment Options](#deployment-options)
11. [Testing & Verification](#testing--verification)
12. [Ongoing Maintenance](#ongoing-maintenance)

---

## Overview

Radl Ops is a **security-first** autonomous AI assistant designed to help manage the Radl SaaS business. Unlike OpenClaw (which has suffered major security incidents), Radl Ops is built with:

- **Mandatory approval workflows** for sensitive actions
- **No open skill marketplace** (curated tools only)
- **Scoped API permissions** (least privilege)
- **Audit logging** for all actions

### What Radl Ops Can Do

| Capability | Description | Risk Level |
|------------|-------------|------------|
| **Feature Planning** | Brainstorm ideas, create GitHub issues | Low |
| **Daily Briefings** | Summarize business metrics, tasks | Low |
| **Weekly Briefings** | Comprehensive progress reports | Low |
| **GitHub Management** | List/create issues, view PRs | Low-Medium |
| **Social Media Drafts** | Draft posts for review | Medium |
| **Social Media Posts** | Post to Twitter/LinkedIn | High (requires approval) |
| **Code Assistance** | Create PRs, merge code | High (requires approval) |

---

## Architecture Decision

Based on research of OpenClaw, Leon, Mycroft/OVOS, and Rhasspy, Radl Ops uses:

### Adopted Patterns

| Pattern | Source | Why |
|---------|--------|-----|
| Multi-channel messaging | OpenClaw | Connect via Slack, Email, CLI |
| Tool registry system | OpenClaw | Extensible without marketplace risk |
| Approval workflows | Security research | Human-in-the-loop for sensitive ops |
| Persistent memory (Markdown) | OpenClaw | Context retention across sessions |
| Modular components | Mycroft/OVOS | Swap providers easily |
| Text-first interface | Zuckerberg's Jarvis | More practical than voice |

### Rejected Patterns

| Pattern | Source | Why Rejected |
|---------|--------|--------------|
| Open skill marketplace | OpenClaw | 341+ malicious skills found |
| Opt-in sandboxing | OpenClaw | Too easy to skip |
| Embedded credentials | Common mistake | Prompt injection exposure |
| Auto-install tools | OpenClaw | Supply chain attack vector |

---

## Prerequisites

### Required Software

```bash
# Node.js 20+ (required)
node --version  # Should be v20.x or higher

# Git (required)
git --version

# Optional: Docker (for containerized deployment)
docker --version
```

### Required Accounts

You will need accounts with:

1. **Anthropic** - For Claude API (the AI brain)
2. **GitHub** - For repository access
3. **Slack** - For team communication
4. **Resend** - For email delivery
5. **Twitter/X** - For social media (optional)
6. **LinkedIn** - For social media (optional)

---

## Account Setup

### 1. Anthropic Account

**Purpose**: Powers the AI reasoning engine

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account or sign in
3. Navigate to **API Keys**
4. Click **Create Key**
5. Name it `radl-ops-production`
6. Copy and save the key (starts with `sk-ant-`)

**Cost Estimate**: ~$5-20/month depending on usage

**Security Notes**:
- [ ] Never commit this key to git
- [ ] Rotate keys every 90 days
- [ ] Set usage limits in Anthropic console

### 2. GitHub Personal Access Token

**Purpose**: Manage issues, PRs, and code in the Radl repository

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Name: `radl-ops-bot`
4. Expiration: 90 days (set a calendar reminder)
5. Select scopes:
   - [x] `repo` (Full control of private repositories)
   - [x] `read:org` (Read org membership)
   - [ ] Do NOT select `delete_repo` or `admin:org`
6. Generate and copy token (starts with `ghp_`)

**Security Notes**:
- [ ] Use fine-grained tokens if available
- [ ] Limit to specific repositories only
- [ ] Rotate every 90 days

### 3. Slack App Setup (Detailed Below)

### 4. Resend Account

**Purpose**: Send briefing emails and notifications

1. Go to [resend.com](https://resend.com)
2. Create an account
3. Verify your domain (or use their test domain)
4. Navigate to **API Keys**
5. Create a key named `radl-ops`
6. Copy the key (starts with `re_`)

**Domain Verification** (recommended for production):
```
Add DNS records:
TXT  _resend.yourdomain.com  → (value from Resend)
```

### 5. Twitter/X Developer Account (Optional)

**Purpose**: Post updates about Radl

1. Go to [developer.twitter.com](https://developer.twitter.com)
2. Apply for developer access (may take 24-48 hours)
3. Create a new App
4. Navigate to **Keys and Tokens**
5. Generate:
   - API Key
   - API Secret
   - Access Token
   - Access Secret

**Note**: Twitter API now requires paid tier ($100/month basic)

### 6. LinkedIn API (Optional)

**Purpose**: Post professional updates

1. Go to [linkedin.com/developers](https://www.linkedin.com/developers/)
2. Create an app
3. Request access to Marketing API
4. Generate access token

**Note**: LinkedIn API requires company page admin access

---

## Slack App Setup

This is the most complex setup. Follow carefully.

### Step 1: Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. App Name: `Radl Ops`
5. Select your workspace
6. Click **Create App**

### Step 2: Enable Socket Mode

Socket Mode allows the bot to receive events without a public URL.

1. In the left sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** ON
3. Create an App-Level Token:
   - Token Name: `radl-ops-socket`
   - Scope: `connections:write`
4. Copy the token (starts with `xapp-`)

### Step 3: Configure Bot Token Scopes

1. Click **OAuth & Permissions** in sidebar
2. Scroll to **Bot Token Scopes**
3. Add these scopes:

```
app_mentions:read     - Respond when mentioned
channels:history      - Read channel messages
channels:read         - View channel list
chat:write            - Send messages
groups:history        - Read private channel messages
groups:read           - View private channels
im:history            - Read DMs
im:read               - View DMs list
im:write              - Send DMs
users:read            - View user info
```

### Step 4: Enable Events

1. Click **Event Subscriptions** in sidebar
2. Toggle **Enable Events** ON
3. Under **Subscribe to bot events**, add:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`

### Step 5: Install to Workspace

1. Click **Install App** in sidebar
2. Click **Install to Workspace**
3. Review permissions and click **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### Step 6: Get Signing Secret

1. Click **Basic Information** in sidebar
2. Scroll to **App Credentials**
3. Copy the **Signing Secret**

### Step 7: Get Channel ID

1. In Slack, right-click on the channel where Radl Ops should post
2. Click **View channel details**
3. At the bottom, copy the **Channel ID** (starts with `C`)

### Slack Credentials Summary

You should now have:

| Credential | Format | Where to Find |
|------------|--------|---------------|
| Bot Token | `xoxb-...` | OAuth & Permissions |
| App Token | `xapp-...` | Socket Mode |
| Signing Secret | 32 hex chars | Basic Information |
| Channel ID | `C...` | Channel details in Slack |

---

## API Keys & Credentials

### Create Your .env File

```bash
cd /home/hb/radl-ops
cp .env.example .env
```

### Fill In All Values

```env
# ============================================
# RADL OPS CONFIGURATION
# ============================================

# Anthropic API (REQUIRED)
# Get from: https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE

# GitHub (REQUIRED for code features)
# Get from: https://github.com/settings/tokens
GITHUB_TOKEN=ghp_YOUR_TOKEN_HERE
GITHUB_OWNER=Sn1ckerDood1e
GITHUB_REPO=Radl

# Slack (REQUIRED for Slack integration)
# Get from: https://api.slack.com/apps
SLACK_BOT_TOKEN=xoxb-YOUR_BOT_TOKEN
SLACK_APP_TOKEN=xapp-YOUR_APP_TOKEN
SLACK_SIGNING_SECRET=YOUR_SIGNING_SECRET
SLACK_CHANNEL_ID=C0123456789

# Supabase (OPTIONAL - for Radl database access)
# Get from: Supabase project settings
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Email via Resend (REQUIRED for email briefings)
# Get from: https://resend.com/api-keys
RESEND_API_KEY=re_YOUR_KEY
BRIEFING_EMAIL=you@example.com

# Twitter/X (OPTIONAL)
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# LinkedIn (OPTIONAL)
LINKEDIN_ACCESS_TOKEN=

# ============================================
# GUARDRAILS (Security Settings)
# ============================================

# Require human approval before posting to social media
REQUIRE_APPROVAL_FOR_POSTS=true

# Require human approval before any spending action
REQUIRE_APPROVAL_FOR_SPENDING=true

# Maximum USD the bot can spend without approval (0 = always require)
MAX_AUTONOMOUS_SPEND_USD=0

# ============================================
# APP SETTINGS
# ============================================

NODE_ENV=production
LOG_LEVEL=info
```

### Verify Credentials

```bash
# Test that all required credentials are set
npm run cli

# In the CLI, type:
/tools
# Should list all available tools

# Test GitHub connection:
> What are the open issues in the Radl repo?

# Test briefing generation:
> Generate a daily briefing
```

---

## Security Configuration

### Permission Tiers

Radl Ops uses a tiered permission system:

| Tier | Actions | Approval Required |
|------|---------|-------------------|
| **Tier 1** | Read issues, get stats, list PRs | No |
| **Tier 2** | Create issues, draft posts | No |
| **Tier 3** | Comment on issues, update issues | No |
| **Tier 4** | Create PRs, merge code | **Yes** |
| **Tier 5** | Post to social media, send emails | **Yes** |

### Approval Workflow

When Radl Ops needs to perform a sensitive action:

1. Bot explains what it wants to do
2. Requests approval via Slack or CLI
3. You respond with `approve` or `reject`
4. Bot executes (or cancels) the action
5. Action is logged for audit

### Audit Logging

All actions are logged with:
- Timestamp
- Action type
- Parameters
- Approval status
- Who approved/rejected
- Result

---

## Deployment Options

### Option 1: Local Development (Recommended to Start)

```bash
cd /home/hb/radl-ops
npm install
npm run cli
```

### Option 2: Background Service (Linux)

Create a systemd service:

```bash
sudo nano /etc/systemd/system/radl-ops.service
```

```ini
[Unit]
Description=Radl Ops AI Assistant
After=network.target

[Service]
Type=simple
User=hb
WorkingDirectory=/home/hb/radl-ops
ExecStart=/usr/bin/node dist/index.js all
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# Build and start
npm run build
sudo systemctl enable radl-ops
sudo systemctl start radl-ops

# Check status
sudo systemctl status radl-ops

# View logs
sudo journalctl -u radl-ops -f
```

### Option 3: Docker (Recommended for Production)

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist

# Run as non-root user
USER node

CMD ["node", "dist/index.js", "all"]
```

```bash
# Build and run
docker build -t radl-ops .
docker run -d --name radl-ops --env-file .env radl-ops
```

### Option 4: Cloud Deployment

**Recommended**: Railway, Render, or Fly.io

```bash
# Fly.io example
fly launch --name radl-ops
fly secrets import < .env
fly deploy
```

---

## Testing & Verification

### Test Checklist

Run these tests after setup:

```bash
# 1. Start the CLI
npm run cli

# 2. Test basic response
> Hello

# 3. Test GitHub integration
> List the open issues in the Radl repo

# 4. Test briefing generation
> Generate a daily briefing

# 5. Test approval workflow
> Create a GitHub issue titled "Test Issue" with body "This is a test"
# Should ask for approval
> reject

# 6. Test scheduled tasks
/tasks
# Should show daily and weekly briefing tasks
```

### Verify Slack Integration

1. Open Slack
2. Go to the channel you configured
3. Type `@Radl Ops hello`
4. Bot should respond

### Verify Email Integration

```bash
# In CLI
> Send me a test briefing via email
```

Check your inbox for the briefing email.

---

## Ongoing Maintenance

### Weekly Tasks

- [ ] Review audit logs for unexpected actions
- [ ] Check for pending approvals
- [ ] Verify briefings are being sent

### Monthly Tasks

- [ ] Review and rotate API keys approaching expiration
- [ ] Check Anthropic usage and costs
- [ ] Update dependencies: `npm update`
- [ ] Review new security advisories

### Quarterly Tasks

- [ ] Full security audit of tool permissions
- [ ] Rotate all API keys
- [ ] Review and update guardrail settings
- [ ] Backup memory/state files

### Key Rotation Schedule

| Credential | Rotation Period | Reminder |
|------------|-----------------|----------|
| Anthropic API Key | 90 days | Set calendar |
| GitHub Token | 90 days | Set calendar |
| Slack Tokens | 1 year | Set calendar |
| Resend API Key | 1 year | Set calendar |

---

## Troubleshooting

### Common Issues

#### "ANTHROPIC_API_KEY not configured"

```bash
# Check .env file exists and has the key
cat .env | grep ANTHROPIC
```

#### Slack bot not responding

1. Check Socket Mode is enabled
2. Verify bot is in the channel
3. Check App Token has `connections:write` scope
4. View logs: `npm run dev`

#### Briefings not sending

1. Check Resend API key is valid
2. Verify `BRIEFING_EMAIL` is set
3. Check email domain is verified in Resend

#### GitHub "Bad credentials"

1. Token may have expired
2. Regenerate at github.com/settings/tokens
3. Update `.env` file
4. Restart the service

---

## Next Steps

After completing this setup:

1. **Customize System Prompt** - Edit `src/agent/core.ts` to add Radl-specific context
2. **Add More Tools** - Create new tools in `src/tools/` for specific needs
3. **Configure Schedules** - Adjust briefing times in `src/scheduler/`
4. **Set Up Monitoring** - Add error alerting for production

---

## Security Checklist

Before going to production:

- [ ] All API keys are in `.env`, not in code
- [ ] `.env` is in `.gitignore`
- [ ] `REQUIRE_APPROVAL_FOR_POSTS=true`
- [ ] `REQUIRE_APPROVAL_FOR_SPENDING=true`
- [ ] GitHub token has minimum required scopes
- [ ] Slack app has minimum required scopes
- [ ] Service runs as non-root user
- [ ] Audit logging is enabled
- [ ] Key rotation reminders are set

---

## Support

If you encounter issues:

1. Check the logs: `npm run dev` or `journalctl -u radl-ops`
2. Review this guide for missed steps
3. Check API provider status pages
4. File an issue in the radl-ops repo
