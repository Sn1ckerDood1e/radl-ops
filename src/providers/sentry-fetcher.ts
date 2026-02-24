/**
 * Sentry DataFetcher — error monitoring retrieval.
 */

import type { DataFetcher, FetcherResult } from './data-fetcher.js';

interface SentryQuery {
  authToken: string;
  org: string;
  project: string;
  statsPeriod?: string;
}

interface SentryIssue {
  id: string;
  title: string;
  level: string;
  count: string;
}

export interface SentryData {
  issues: SentryIssue[];
  errorCount: number;
  warningCount: number;
}

export const sentryFetcher: DataFetcher<SentryQuery, SentryData> = {
  name: 'sentry',

  transformQuery({ authToken, org, project, statsPeriod = '24h' }) {
    if (!authToken || !org || !project) return null;
    return {
      url: `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=is:unresolved&statsPeriod=${encodeURIComponent(statsPeriod)}&sort=freq`,
      headers: { Authorization: `Bearer ${authToken}` },
    };
  },

  extractData(raw) {
    const issues = raw as SentryIssue[];
    const errorCount = issues.filter(i => i.level === 'error').length;
    const warningCount = issues.filter(i => i.level === 'warning').length;
    return { issues, errorCount, warningCount };
  },

  transformResult(data, error): FetcherResult<SentryData> {
    if (error === 'not_configured') {
      return { status: 'unavailable', summary: 'Sentry credentials not configured', data: null };
    }
    if (!data) {
      return { status: 'error', summary: `Failed to reach Sentry API${error ? `: ${error}` : ''}`, data: null };
    }
    if (data.issues.length === 0) {
      return { status: 'ok', summary: 'No unresolved errors in last 24h', data };
    }

    const details = data.issues.slice(0, 5).map(i =>
      `[${i.level}] ${i.title.slice(0, 80)} (${i.count}x)`
    );

    const status = data.errorCount > 5 ? 'error' : data.errorCount > 0 ? 'warning' : 'ok';

    return {
      status,
      summary: `${data.issues.length} unresolved issues (${data.errorCount} errors, ${data.warningCount} warnings)`,
      data,
      details,
    };
  },
};
