/**
 * Supabase DataFetcher — project health retrieval.
 *
 * SECURITY: Never include database.host or connection strings in output.
 * Output flows to Anthropic API via briefings.
 */

import type { DataFetcher, FetcherResult } from './data-fetcher.js';

interface SupabaseQuery {
  projectId: string;
  accessToken: string;
}

export interface SupabaseData {
  name: string;
  status: string;
  region: string;
}

export const supabaseFetcher: DataFetcher<SupabaseQuery, SupabaseData> = {
  name: 'supabase',

  transformQuery({ projectId, accessToken }) {
    if (!projectId || !accessToken) return null;
    return {
      url: `https://api.supabase.com/v1/projects/${encodeURIComponent(projectId)}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  },

  extractData(raw) {
    const { name, status, region } = raw as { name: string; status: string; region: string };
    return { name, status, region };
  },

  transformResult(data, error): FetcherResult<SupabaseData> {
    if (error === 'not_configured') {
      return { status: 'unavailable', summary: 'Supabase project ID or access token not configured', data: null };
    }
    if (!data) {
      return { status: 'error', summary: `Failed to reach Supabase Management API${error ? `: ${error}` : ''}`, data: null };
    }

    const details = [
      `Project: ${data.name}`,
      `Status: ${data.status}`,
      `Region: ${data.region}`,
    ];

    const status = data.status === 'ACTIVE_HEALTHY' ? 'ok' : 'warning';

    return {
      status,
      summary: `${data.status}${data.region ? ` (${data.region})` : ''}`,
      data,
      details,
    };
  },
};
