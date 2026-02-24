/**
 * Vercel DataFetcher — deployment status retrieval.
 */

import type { DataFetcher, FetcherResult } from './data-fetcher.js';

interface VercelQuery {
  token: string;
  projectId: string;
  limit?: number;
}

interface VercelDeployment {
  uid: string;
  readyState: string;
  createdAt: number;
  meta?: { githubCommitMessage?: string };
}

export interface VercelData {
  deployments: VercelDeployment[];
  latest: VercelDeployment | null;
  failedCount: number;
  hoursAgo: number;
}

export const vercelFetcher: DataFetcher<VercelQuery, VercelData> = {
  name: 'vercel',

  transformQuery({ token, projectId, limit = 5 }) {
    if (!token || !projectId) return null;
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 20);
    return {
      url: `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=${safeLimit}&target=production`,
      headers: { Authorization: `Bearer ${token}` },
    };
  },

  extractData(raw) {
    const { deployments = [] } = raw as { deployments: VercelDeployment[] };
    const latest = deployments[0] ?? null;
    const failedCount = deployments.filter(d => d.readyState === 'ERROR').length;
    const hoursAgo = latest
      ? Math.round((Date.now() - latest.createdAt) / (1000 * 60 * 60))
      : 0;

    return { deployments, latest, failedCount, hoursAgo };
  },

  transformResult(data, error): FetcherResult<VercelData> {
    if (error === 'not_configured') {
      return { status: 'unavailable', summary: 'Vercel token or project ID not configured', data: null };
    }
    if (!data) {
      return { status: 'error', summary: `Failed to reach Vercel API${error ? `: ${error}` : ''}`, data: null };
    }
    if (!data.latest) {
      return { status: 'warning', summary: 'No production deployments found', data };
    }

    const details = [
      `Latest: ${data.latest.readyState} (${data.hoursAgo}h ago)`,
      `Commit: ${data.latest.meta?.githubCommitMessage?.slice(0, 80) ?? 'unknown'}`,
    ];
    if (data.failedCount > 0) {
      details.push(`${data.failedCount} of last ${data.deployments.length} deployments failed`);
    }

    const status = data.latest.readyState === 'READY'
      ? (data.failedCount > 0 ? 'warning' : 'ok')
      : 'error';

    return {
      status,
      summary: `Latest deploy: ${data.latest.readyState} (${data.hoursAgo}h ago)${data.failedCount > 0 ? `, ${data.failedCount} recent failures` : ''}`,
      data,
      details,
    };
  },
};
