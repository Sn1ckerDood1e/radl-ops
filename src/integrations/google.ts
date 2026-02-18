/**
 * Direct Google API client for Gmail and Calendar.
 *
 * Uses the same OAuth credentials as Google Workspace MCP
 * (stored in ~/.google_workspace_mcp/credentials/).
 * No external dependencies — uses Node.js built-in fetch.
 *
 * Token refresh is automatic; updated tokens are persisted
 * back to the credentials file so the Workspace MCP stays in sync.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../config/logger.js';

interface GoogleCredentials {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function resolveCredentialsPath(): string {
  const explicit = process.env.GOOGLE_CREDENTIALS_PATH;
  if (explicit) return explicit;

  // Scan the default directory for the first credentials file
  const dir = join(process.env.HOME ?? '/root', '.google_workspace_mcp', 'credentials');
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) throw new Error('No credential files found');
    return join(dir, files[0]);
  } catch {
    throw new Error(
      `Google credentials not found. Set GOOGLE_CREDENTIALS_PATH or run Google Workspace MCP OAuth flow first.`
    );
  }
}

let cachedCreds: GoogleCredentials | null = null;
let credentialsPath: string | null = null;

function loadCredentials(): GoogleCredentials {
  if (cachedCreds) return cachedCreds;
  credentialsPath = resolveCredentialsPath();
  cachedCreds = JSON.parse(readFileSync(credentialsPath, 'utf-8')) as GoogleCredentials;
  return cachedCreds;
}

async function getAccessToken(): Promise<string> {
  const creds = loadCredentials();

  // Return cached token if not expired (with 5-minute buffer)
  const expiry = new Date(creds.expiry).getTime();
  if (Date.now() < expiry - 5 * 60 * 1000) {
    return creds.token;
  }

  logger.debug('Google OAuth token expired, refreshing...');

  const response = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  // Update cached + persisted credentials
  creds.token = data.access_token;
  creds.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  cachedCreds = creds;

  if (credentialsPath) {
    writeFileSync(credentialsPath, JSON.stringify(creds, null, 2) + '\n');
  }

  logger.debug('Google OAuth token refreshed', { expiresIn: data.expires_in });
  return creds.token;
}

/**
 * Check if Google credentials are available (non-throwing).
 */
export function isGoogleConfigured(): boolean {
  try {
    loadCredentials();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export async function sendGmail(params: {
  to: string;
  subject: string;
  htmlBody: string;
}): Promise<{ messageId: string }> {
  const token = await getAccessToken();

  // Build RFC 2822 MIME message
  const boundary = `boundary_${Date.now()}`;
  const message = [
    `To: ${params.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(params.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(params.htmlBody).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');

  // Base64url encode for Gmail API
  const raw = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { id: string; threadId: string };
  logger.info('Gmail sent', { messageId: result.id, to: params.to, subject: params.subject });
  return { messageId: result.id };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

interface CalendarEventParams {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  calendarId?: string;
}

interface CalendarEvent {
  id: string;
  htmlLink: string;
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
}

export async function createCalendarEvent(params: CalendarEventParams): Promise<{ eventId: string; htmlLink: string }> {
  const token = await getAccessToken();
  const calId = params.calendarId ?? 'primary';

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: params.summary,
        description: params.description ?? '',
        start: { dateTime: params.start.toISOString() },
        end: { dateTime: params.end.toISOString() },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Calendar event creation failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as CalendarEvent;
  logger.info('Calendar event created', { eventId: result.id, summary: params.summary });
  return { eventId: result.id, htmlLink: result.htmlLink };
}

export async function updateCalendarEvent(params: {
  eventId: string;
  summary?: string;
  start?: Date;
  end?: Date;
  description?: string;
  calendarId?: string;
}): Promise<void> {
  const token = await getAccessToken();
  const calId = params.calendarId ?? 'primary';

  const body: Record<string, unknown> = {};
  if (params.summary) body.summary = params.summary;
  if (params.start) body.start = { dateTime: params.start.toISOString() };
  if (params.end) body.end = { dateTime: params.end.toISOString() };
  if (params.description !== undefined) body.description = params.description;

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(params.eventId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Calendar event update failed (${response.status}): ${text}`);
  }

  logger.info('Calendar event updated', { eventId: params.eventId });
}

export async function getCalendarEvents(params: {
  timeMin: Date;
  timeMax: Date;
  calendarId?: string;
  maxResults?: number;
}): Promise<Array<{ id: string; summary: string; start: string; end: string }>> {
  const token = await getAccessToken();
  const calId = params.calendarId ?? 'primary';

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
  );
  url.searchParams.set('timeMin', params.timeMin.toISOString());
  url.searchParams.set('timeMax', params.timeMax.toISOString());
  url.searchParams.set('maxResults', String(params.maxResults ?? 20));
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Calendar events fetch failed (${response.status}): ${text}`);
  }

  interface GCalItem { id: string; summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }
  const result = (await response.json()) as { items: GCalItem[] };

  return (result.items ?? []).map(e => ({
    id: e.id,
    summary: e.summary ?? '',
    start: e.start.dateTime ?? e.start.date ?? '',
    end: e.end.dateTime ?? e.end.date ?? '',
  }));
}
