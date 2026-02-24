/**
 * GitHub DataFetcher — issue tracking retrieval.
 */

import type { DataFetcher, FetcherResult } from './data-fetcher.js';

interface GitHubQuery {
  token: string;
  owner: string;
  repo: string;
  perPage?: number;
}

interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

export interface GitHubData {
  issues: GitHubIssue[];
  bugCount: number;
}

export const githubFetcher: DataFetcher<GitHubQuery, GitHubData> = {
  name: 'github',

  transformQuery({ token, owner, repo, perPage = 10 }) {
    if (!token || !owner || !repo) return null;
    const safePage = Math.min(Math.max(1, Math.floor(perPage)), 30);
    return {
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=${safePage}&sort=created&direction=desc`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
    };
  },

  extractData(raw) {
    const allItems = raw as GitHubIssue[];
    // Filter out PRs (GitHub API returns both)
    const issues = allItems.filter(i => !i.pull_request);
    const bugCount = issues.filter(i =>
      i.labels.some(l => l.name.toLowerCase().includes('bug'))
    ).length;
    return { issues, bugCount };
  },

  transformResult(data, error): FetcherResult<GitHubData> {
    if (error === 'not_configured') {
      return { status: 'unavailable', summary: 'GitHub token not configured', data: null };
    }
    if (!data) {
      return { status: 'error', summary: `Failed to reach GitHub API${error ? `: ${error}` : ''}`, data: null };
    }
    if (data.issues.length === 0) {
      return { status: 'ok', summary: 'No open issues', data };
    }

    const details = data.issues.slice(0, 5).map(i =>
      `#${i.number}: ${i.title.slice(0, 60)}`
    );

    const status = data.bugCount > 3 ? 'warning' : 'ok';

    return {
      status,
      summary: `${data.issues.length} open issues${data.bugCount > 0 ? ` (${data.bugCount} bugs)` : ''}`,
      data,
      details,
    };
  },
};
