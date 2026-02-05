# Radl SaaS Launch Guide

**Created:** 2026-01-26
**Purpose:** Checklist and guidance for taking Radl from working software to commercial SaaS business.

---

## Executive Summary

Radl v2.0 is feature-complete for commercial sale. This document covers what's needed beyond the code: legal foundation, financial infrastructure, and operational readiness.

---

## 1. Legal Foundation

### 1.1 Business Entity

**Priority: HIGH** — Do this first, everything else depends on it.

| Task | Notes |
|------|-------|
| Form LLC or Corporation | LLC is simpler for small SaaS; consider Delaware for investor-friendly laws |
| Get EIN (Employer Identification Number) | Free from IRS, needed for business bank account |
| Register in states where you operate | May need foreign LLC registration if operating in multiple states |
| Business license | Check local requirements |

**Resources:**
- Stripe Atlas — $500, handles Delaware LLC + bank account + Stripe setup
- Clerky — standard legal docs for startups
- LegalZoom / Northwest Registered Agent — cheaper LLC formation

### 1.2 Terms of Service (ToS)

**Priority: HIGH** — Required before accepting users.

Your ToS should cover:

- [ ] Service description and limitations
- [ ] User responsibilities (accurate data, authorized use)
- [ ] Acceptable use policy (no illegal activity, no abuse)
- [ ] Account termination rights (yours and theirs)
- [ ] Payment terms and refund policy
- [ ] Intellectual property (you own the platform, they own their data)
- [ ] Limitation of liability (cap damages, disclaim warranties)
- [ ] Dispute resolution (arbitration clause, jurisdiction)
- [ ] Modification rights (how you'll notify of changes)

**Resources:**
- Termly — generates ToS from questionnaire (~$10/month)
- Docracy — free templates (review carefully)
- Attorney review — $500-2000 for custom ToS

### 1.3 Privacy Policy

**Priority: HIGH** — Legally required in most jurisdictions.

Must address:

- [ ] What data you collect (PII, usage data, cookies)
- [ ] How you use the data
- [ ] Who you share it with (Supabase, Stripe, analytics)
- [ ] Data retention periods
- [ ] User rights (access, deletion, portability)
- [ ] Cookie consent mechanism
- [ ] Contact information for privacy inquiries
- [ ] GDPR compliance (if serving EU users)
- [ ] CCPA compliance (if serving California users)

**Radl-specific considerations:**
- You store athlete names, practice schedules, team rosters
- Minors may be users (athletes) — COPPA considerations
- Parent accounts access children's data — document this clearly

### 1.4 Data Processing Agreement (DPA)

**Priority: MEDIUM** — Needed for enterprise/facility customers.

- Standard contractual clauses for GDPR
- Sub-processor list (Supabase, Vercel, etc.)
- Security measures documentation
- Breach notification procedures

### 1.5 Insurance

**Priority: MEDIUM** — Protects against lawsuits.

| Type | Coverage | Estimated Cost |
|------|----------|----------------|
| General Liability | Physical injury, property damage | $500-1000/year |
| Professional Liability (E&O) | Software errors, advice liability | $1000-3000/year |
| Cyber Liability | Data breaches, ransomware | $1000-5000/year |

**Providers:** Hiscox, Next Insurance, Embroker (tech-focused)

---

## 2. Financial Infrastructure

### 2.1 Business Banking

**Priority: HIGH** — Separate business and personal finances.

- [ ] Open business checking account (requires EIN)
- [ ] Get business debit card
- [ ] Set up accounting categories

**Recommended:** Mercury, Relay, Brex (startup-friendly, no fees)

### 2.2 Payment Processing

**Priority: HIGH** — How customers pay you.

**Stripe is the standard choice:**
- 2.9% + $0.30 per transaction
- Handles subscriptions, invoicing, tax calculation
- PCI compliance handled for you
- Stripe Billing for SaaS subscription management

**Implementation:**
- [ ] Create Stripe account (connect to business bank)
- [ ] Set up products and pricing in Stripe Dashboard
- [ ] Implement Stripe Checkout or embedded pricing table
- [ ] Handle webhooks for subscription lifecycle events
- [ ] Customer portal for self-service billing management

**Alternative:** Paddle (handles sales tax globally, acts as merchant of record)

### 2.3 Pricing Strategy

**Priority: HIGH** — Decide before launch.

**Common SaaS pricing models:**

| Model | Pros | Cons |
|-------|------|------|
| Per-seat | Scales with value | Discourages adoption |
| Per-team flat rate | Simple, predictable | Doesn't scale with large teams |
| Tiered (features) | Upsell path | Complexity |
| Usage-based | Fair, scales | Unpredictable revenue |

**Radl recommendation:**
```
Free Tier: 1 team, 15 athletes, basic features
Team Plan: $29/month - 1 team, unlimited athletes, full features
Club Plan: $99/month - 5 teams, shared equipment, facility features
Facility Plan: $249/month - unlimited teams, all features, priority support
```

### 2.4 Accounting & Bookkeeping

**Priority: MEDIUM** — Track money in/out.

- [ ] Set up accounting software (QuickBooks, Xero, Wave)
- [ ] Connect to bank and Stripe
- [ ] Categorize transactions monthly
- [ ] Track MRR, churn, CAC, LTV metrics

**Consider:** Hiring a bookkeeper ($200-500/month) once revenue > $5k/month

### 2.5 Sales Tax / VAT

**Priority: MEDIUM** — Complex, depends on where customers are.

**US:**
- SaaS taxability varies by state
- Use Stripe Tax or TaxJar to automate
- Register for sales tax in states where you have "nexus"

**International:**
- VAT required for EU customers
- Consider using Paddle as merchant of record (they handle all taxes)

---

## 3. App & Infrastructure Readiness

### 3.1 Production Hosting

**Priority: HIGH** — Where the app runs.

**Current stack implications:**
- Vercel for Next.js hosting (recommended, free tier generous)
- Supabase for database and auth (already using)
- Consider Vercel Pro ($20/month) for production features

**Checklist:**
- [ ] Custom domain configured (radl.com or similar)
- [ ] SSL certificate (automatic with Vercel/Supabase)
- [ ] Environment variables properly secured
- [ ] Production database separate from development

### 3.2 Monitoring & Observability

**Priority: HIGH** — Know when things break.

| Tool | Purpose | Cost |
|------|---------|------|
| Sentry | Error tracking | Free tier, then $26/month |
| Vercel Analytics | Performance monitoring | Included with Vercel |
| Supabase Dashboard | Database monitoring | Included |
| UptimeRobot | Uptime monitoring | Free for 50 monitors |
| LogSnag | Event tracking | Free tier available |

**Minimum setup:**
- [ ] Error tracking (Sentry)
- [ ] Uptime monitoring
- [ ] Database query performance monitoring

### 3.3 Backup & Disaster Recovery

**Priority: HIGH** — Don't lose customer data.

- [ ] Supabase automatic backups (check retention period)
- [ ] Point-in-time recovery enabled
- [ ] Document recovery procedures
- [ ] Test restore process quarterly

### 3.4 Security Hardening

**Priority: HIGH** — Already good from v2.0, verify these:

- [ ] Rate limiting on all endpoints
- [ ] CSRF protection
- [ ] Content Security Policy headers
- [ ] Dependency vulnerability scanning (npm audit, Dependabot)
- [ ] Secret rotation procedures documented
- [ ] Admin access audit trail

### 3.5 Support Infrastructure

**Priority: MEDIUM** — How customers get help.

**Options by stage:**

| Stage | Solution | Cost |
|-------|----------|------|
| Early | Personal email + Notion FAQ | Free |
| Growing | Crisp, Intercom, or Help Scout | $0-50/month |
| Scaling | Zendesk, Freshdesk | $50+/month |

**Minimum for launch:**
- [ ] Support email address (support@radl.com)
- [ ] FAQ / Help documentation
- [ ] Response time expectation set (e.g., 24-48 hours)

---

## 4. Go-to-Market

### 4.1 Landing Page

**Priority: HIGH** — First impression for potential customers.

**Must have:**
- [ ] Clear value proposition above the fold
- [ ] Feature highlights with screenshots
- [ ] Pricing table
- [ ] Social proof (testimonials, logos if available)
- [ ] Call-to-action (Start Free Trial)
- [ ] FAQ section

**Tools:** Same Next.js app with marketing pages, or separate Framer/Webflow site

### 4.2 Domain & Email

**Priority: HIGH**

- [ ] Register domain (radl.com, radl.sol, etc.)
- [ ] Set up professional email (Google Workspace $6/user/month or Zoho free)
- [ ] Configure SPF, DKIM, DMARC for email deliverability

### 4.3 Initial Marketing

**Priority: MEDIUM** — Get first customers.

**Rowing-specific channels:**
- Row2k forums and community
- USRowing club directory outreach
- Rowing coaches Facebook groups
- Direct outreach to clubs you know

**Content marketing:**
- "How to run an efficient rowing practice" blog posts
- Comparison with spreadsheet/paper methods
- Case study with beta user

### 4.4 Beta Program

**Priority: RECOMMENDED** — Validate before full launch.

- [ ] Recruit 3-5 clubs for free beta
- [ ] Gather feedback systematically
- [ ] Fix critical issues
- [ ] Get testimonials and case studies
- [ ] Convert beta users to paid when ready

---

## 5. Launch Checklist

### Pre-Launch (2-4 weeks before)

- [ ] Legal entity formed
- [ ] Business bank account open
- [ ] Terms of Service written
- [ ] Privacy Policy written
- [ ] Stripe account set up with products/prices
- [ ] Production environment configured
- [ ] Error monitoring active
- [ ] Support email configured
- [ ] Landing page live
- [ ] Beta testing complete

### Launch Day

- [ ] Enable payment processing
- [ ] Announce to waiting list / beta users
- [ ] Post to relevant communities
- [ ] Monitor for issues actively
- [ ] Respond to support requests promptly

### Post-Launch (first 30 days)

- [ ] Daily monitoring of errors and performance
- [ ] Weekly user feedback review
- [ ] Track key metrics (signups, conversions, churn)
- [ ] Iterate on onboarding based on drop-off points
- [ ] Publish first customer success story

---

## 6. Metrics to Track

### Business Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| MRR | Monthly Recurring Revenue | Growth month-over-month |
| Churn | % customers canceling per month | < 5% |
| CAC | Cost to acquire a customer | < 3 months of revenue |
| LTV | Lifetime value of customer | > 3x CAC |
| NPS | Net Promoter Score | > 30 |

### Product Metrics

| Metric | Definition | Why It Matters |
|--------|------------|----------------|
| DAU/MAU | Daily/Monthly active users | Engagement health |
| Feature adoption | % using key features | Value delivery |
| Time to value | How fast users get first practice created | Onboarding quality |
| Support ticket volume | Requests per customer | Product clarity |

---

## 7. Cost Estimates

### Monthly Operating Costs (Early Stage)

| Item | Cost | Notes |
|------|------|-------|
| Vercel Pro | $20 | Hosting |
| Supabase Pro | $25 | Database + Auth |
| Domain | $1 | Amortized yearly |
| Google Workspace | $6 | Professional email |
| Stripe | 2.9% + $0.30 | Per transaction |
| Sentry | $0-26 | Error tracking |
| **Total Fixed** | ~$52/month | Before revenue |

### One-Time Costs

| Item | Cost | Notes |
|------|------|-------|
| LLC Formation | $100-500 | State dependent |
| Legal docs review | $500-2000 | Optional but recommended |
| Domain purchase | $10-50 | Yearly |
| Logo/branding | $0-500 | Can DIY initially |

---

## 8. Timeline Recommendation

### Month 1: Foundation
- Form LLC, get EIN
- Open business bank account
- Set up Stripe
- Write ToS and Privacy Policy
- Configure production environment

### Month 2: Beta
- Recruit 3-5 beta clubs
- Implement billing integration
- Build landing page
- Set up support infrastructure
- Gather feedback and iterate

### Month 3: Launch
- Open to public
- Marketing push to rowing community
- Monitor and support actively
- Iterate based on real usage

---

## Resources

### Legal
- [Stripe Atlas](https://stripe.com/atlas) — Business formation bundle
- [Termly](https://termly.io) — Policy generator
- [Clerky](https://clerky.com) — Startup legal docs

### Financial
- [Stripe Billing](https://stripe.com/billing) — Subscription management
- [Mercury](https://mercury.com) — Startup banking
- [Bench](https://bench.co) — Bookkeeping service

### Technical
- [Sentry](https://sentry.io) — Error tracking
- [UptimeRobot](https://uptimerobot.com) — Uptime monitoring
- [Vercel](https://vercel.com) — Hosting

### Learning
- [Indie Hackers](https://indiehackers.com) — Community of bootstrapped founders
- [MicroConf](https://microconf.com) — SaaS founder resources
- [SaaS Metrics 2.0](https://www.forentrepreneurs.com/saas-metrics-2/) — Understanding SaaS business metrics

---

*This document is a starting point. Consult with a lawyer and accountant for advice specific to your situation.*
