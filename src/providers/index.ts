/**
 * Provider barrel export — all DataFetcher implementations.
 */

export { type DataFetcher, type FetcherResult, executeFetcher } from './data-fetcher.js';
export { vercelFetcher, type VercelData } from './vercel-fetcher.js';
export { supabaseFetcher, type SupabaseData } from './supabase-fetcher.js';
export { sentryFetcher, type SentryData } from './sentry-fetcher.js';
export { githubFetcher, type GitHubData } from './github-fetcher.js';
