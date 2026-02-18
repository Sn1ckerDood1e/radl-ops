/**
 * Configuration management for Radl Ops
 */

import { config as dotenvConfig } from 'dotenv';

// Load .env file
dotenvConfig();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string = ''): string {
  return process.env[key] || defaultValue;
}

function boolEnv(key: string, defaultValue: boolean = false): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function numEnv(key: string, defaultValue: number = 0): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const config = {
  // Anthropic
  anthropic: {
    apiKey: optionalEnv('ANTHROPIC_API_KEY'),
  },

  // GitHub
  github: {
    token: optionalEnv('GITHUB_TOKEN'),
    owner: optionalEnv('GITHUB_OWNER', 'Sn1ckerDood1e'),
    repo: optionalEnv('GITHUB_REPO', 'Radl'),
  },

  // Slack
  slack: {
    botToken: optionalEnv('SLACK_BOT_TOKEN'),
    appToken: optionalEnv('SLACK_APP_TOKEN'),
    signingSecret: optionalEnv('SLACK_SIGNING_SECRET'),
    channelId: optionalEnv('SLACK_CHANNEL_ID'),
  },

  // Supabase
  supabase: {
    url: optionalEnv('SUPABASE_URL'),
    anonKey: optionalEnv('SUPABASE_ANON_KEY'),
    serviceKey: optionalEnv('SUPABASE_SERVICE_KEY'),
    projectId: optionalEnv('SUPABASE_PROJECT_ID'),
    accessToken: optionalEnv('SUPABASE_ACCESS_TOKEN'),
  },

  // Vercel
  vercel: {
    token: optionalEnv('VERCEL_TOKEN'),
    projectId: optionalEnv('VERCEL_PROJECT_ID'),
  },

  // Sentry
  sentry: {
    authToken: optionalEnv('SENTRY_AUTH_TOKEN'),
    org: optionalEnv('SENTRY_ORG'),
    project: optionalEnv('SENTRY_PROJECT'),
  },

  // Email
  email: {
    resendApiKey: optionalEnv('RESEND_API_KEY'),
    briefingEmail: optionalEnv('BRIEFING_EMAIL'),
  },

  // Social Media
  social: {
    twitter: {
      apiKey: optionalEnv('TWITTER_API_KEY'),
      apiSecret: optionalEnv('TWITTER_API_SECRET'),
      accessToken: optionalEnv('TWITTER_ACCESS_TOKEN'),
      accessSecret: optionalEnv('TWITTER_ACCESS_SECRET'),
    },
    linkedin: {
      accessToken: optionalEnv('LINKEDIN_ACCESS_TOKEN'),
    },
  },

  // Guardrails
  guardrails: {
    requireApprovalForPosts: boolEnv('REQUIRE_APPROVAL_FOR_POSTS', true),
    requireApprovalForSpending: boolEnv('REQUIRE_APPROVAL_FOR_SPENDING', true),
    maxAutonomousSpendUsd: numEnv('MAX_AUTONOMOUS_SPEND_USD', 0),
  },

  // App
  app: {
    env: optionalEnv('NODE_ENV', 'development'),
    isDev: optionalEnv('NODE_ENV', 'development') === 'development',
  },
};

export type Config = typeof config;
