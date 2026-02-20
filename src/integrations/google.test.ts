/**
 * Behavioral tests for Google API client (OAuth, Gmail, Calendar).
 *
 * Tests:
 * 1. Token refresh flow (caching, expiry detection, SSRF guard, persistence)
 * 2. Gmail send (MIME construction, header injection prevention, error handling)
 * 3. Calendar CRUD (create, update, list events)
 * 4. isGoogleConfigured() — credential availability check
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ─── Credential fixtures ────────────────────────────────────────────────────

function makeCredentials(overrides: Partial<{
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: string;
}> = {}) {
  return {
    token: 'valid-access-token',
    refresh_token: 'refresh-token-123',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_id: 'client-id',
    client_secret: 'client-secret',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
    ...overrides,
  };
}

function setupCredentials(overrides: Partial<Parameters<typeof makeCredentials>[0]> = {}) {
  const creds = makeCredentials(overrides);
  process.env.GOOGLE_CREDENTIALS_PATH = '/tmp/test-creds.json';
  mockReadFileSync.mockReturnValue(JSON.stringify(creds));
  return creds;
}

// ─── Import after mocks ─────────────────────────────────────────────────────

async function loadModule() {
  // Reset module cache to get fresh credential state
  vi.resetModules();
  return import('./google.js');
}

// ─── Reset ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GOOGLE_CREDENTIALS_PATH;
});

// ─── isGoogleConfigured ─────────────────────────────────────────────────────

describe('isGoogleConfigured', () => {
  it('returns true when credentials file exists', async () => {
    setupCredentials();
    const { isGoogleConfigured } = await loadModule();

    expect(isGoogleConfigured()).toBe(true);
  });

  it('returns false when credentials file is missing', async () => {
    process.env.GOOGLE_CREDENTIALS_PATH = '/nonexistent/creds.json';
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { isGoogleConfigured } = await loadModule();

    expect(isGoogleConfigured()).toBe(false);
  });

  it('returns false when no credential files in default directory', async () => {
    // No explicit path, and readdirSync returns empty
    mockReaddirSync.mockReturnValue([]);
    const { isGoogleConfigured } = await loadModule();

    expect(isGoogleConfigured()).toBe(false);
  });
});

// ─── Token Refresh ──────────────────────────────────────────────────────────

describe('Token refresh flow', () => {
  it('uses cached token when not expired', async () => {
    setupCredentials(); // expiry is 1 hour out
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-1', threadId: 'thread-1' }),
    });

    await sendGmail({ to: 'test@example.com', subject: 'Hi', htmlBody: '<p>Hello</p>' });

    // Only 1 fetch call (Gmail send), no token refresh call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('gmail.googleapis.com');
  });

  it('refreshes token when expired', async () => {
    setupCredentials({
      expiry: new Date(Date.now() - 60 * 1000).toISOString(), // expired 1 min ago
    });
    const { sendGmail } = await loadModule();

    // First call: token refresh
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });
    // Second call: Gmail send
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-2', threadId: 'thread-2' }),
    });

    await sendGmail({ to: 'test@example.com', subject: 'Hi', htmlBody: '<p>Hello</p>' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First call was to the token endpoint
    expect(mockFetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
  });

  it('refreshes token within 5-minute buffer before expiry', async () => {
    setupCredentials({
      expiry: new Date(Date.now() + 3 * 60 * 1000).toISOString(), // 3 min out (within 5-min buffer)
    });
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-3', threadId: 'thread-3' }),
    });

    await sendGmail({ to: 'test@example.com', subject: 'Hi', htmlBody: '<p>Hello</p>' });

    // Token refresh happened
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
  });

  it('persists refreshed token to credentials file', async () => {
    setupCredentials({
      expiry: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'persisted-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-4', threadId: 'thread-4' }),
    });

    await sendGmail({ to: 'test@example.com', subject: 'Test', htmlBody: '<p>Body</p>' });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.token).toBe('persisted-token');
  });

  it('rejects token_uri that is not a known Google endpoint (SSRF guard)', async () => {
    setupCredentials({
      token_uri: 'https://evil.com/steal-tokens',
      expiry: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const { sendGmail } = await loadModule();

    await expect(
      sendGmail({ to: 'test@example.com', subject: 'Hi', htmlBody: '<p>Hello</p>' })
    ).rejects.toThrow('Rejected token_uri');
  });

  it('throws when token refresh returns non-OK response', async () => {
    setupCredentials({
      expiry: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid refresh token',
    });

    await expect(
      sendGmail({ to: 'test@example.com', subject: 'Hi', htmlBody: '<p>Hello</p>' })
    ).rejects.toThrow('Google token refresh failed (401)');
  });
});

// ─── Gmail Send ─────────────────────────────────────────────────────────────

describe('sendGmail', () => {
  it('sends email and returns messageId', async () => {
    setupCredentials();
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-100', threadId: 'thread-100' }),
    });

    const result = await sendGmail({
      to: 'user@example.com',
      subject: 'Test Subject',
      htmlBody: '<h1>Hello</h1>',
    });

    expect(result.messageId).toBe('msg-100');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer valid-access-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('constructs base64url-encoded MIME message with proper headers', async () => {
    setupCredentials();
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'msg-id', threadId: 'thread-id' }),
    });

    await sendGmail({
      to: 'recipient@test.com',
      subject: 'UTF-8 Subject',
      htmlBody: '<p>Content</p>',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // raw field should be base64url (no +, no /, no trailing =)
    expect(body.raw).toBeDefined();
    expect(body.raw).not.toMatch(/[+/=]/);

    // Decode and verify MIME structure
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf-8');
    expect(decoded).toContain('To: recipient@test.com');
    expect(decoded).toContain('MIME-Version: 1.0');
    expect(decoded).toContain('Content-Type: text/html; charset=UTF-8');
  });

  it('rejects email address containing CRLF (header injection)', async () => {
    setupCredentials();
    const { sendGmail } = await loadModule();

    await expect(
      sendGmail({ to: 'evil@test.com\r\nBcc: spy@evil.com', subject: 'Hi', htmlBody: '<p>X</p>' })
    ).rejects.toThrow('Invalid email address: contains line break characters');
  });

  it('rejects subject containing newline (header injection)', async () => {
    setupCredentials();
    const { sendGmail } = await loadModule();

    await expect(
      sendGmail({ to: 'user@test.com', subject: 'Hi\nBcc: spy@evil.com', htmlBody: '<p>X</p>' })
    ).rejects.toThrow('Invalid subject: contains line break characters');
  });

  it('throws when Gmail API returns error', async () => {
    setupCredentials();
    const { sendGmail } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Insufficient permissions',
    });

    await expect(
      sendGmail({ to: 'user@test.com', subject: 'Hi', htmlBody: '<p>X</p>' })
    ).rejects.toThrow('Gmail send failed (403)');
  });
});

// ─── Calendar Event Creation ────────────────────────────────────────────────

describe('createCalendarEvent', () => {
  it('creates event and returns eventId + htmlLink', async () => {
    setupCredentials();
    const { createCalendarEvent } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'event-1',
        htmlLink: 'https://calendar.google.com/event/1',
        summary: 'Sprint',
        start: { dateTime: '2026-02-19T10:00:00Z' },
        end: { dateTime: '2026-02-19T12:00:00Z' },
      }),
    });

    const result = await createCalendarEvent({
      summary: 'Sprint',
      start: new Date('2026-02-19T10:00:00Z'),
      end: new Date('2026-02-19T12:00:00Z'),
      description: 'Phase 92',
    });

    expect(result.eventId).toBe('event-1');
    expect(result.htmlLink).toBe('https://calendar.google.com/event/1');
  });

  it('uses primary calendar by default', async () => {
    setupCredentials();
    const { createCalendarEvent } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'e1', htmlLink: 'link', summary: 'X', start: { dateTime: '' }, end: { dateTime: '' } }),
    });

    await createCalendarEvent({
      summary: 'Test',
      start: new Date(),
      end: new Date(),
    });

    expect(mockFetch.mock.calls[0][0]).toContain('/calendars/primary/events');
  });

  it('URL-encodes custom calendarId', async () => {
    setupCredentials();
    const { createCalendarEvent } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'e2', htmlLink: 'link', summary: 'X', start: { dateTime: '' }, end: { dateTime: '' } }),
    });

    await createCalendarEvent({
      summary: 'Test',
      start: new Date(),
      end: new Date(),
      calendarId: 'team@group.calendar.google.com',
    });

    expect(mockFetch.mock.calls[0][0]).toContain(encodeURIComponent('team@group.calendar.google.com'));
  });

  it('throws when Calendar API returns error', async () => {
    setupCredentials();
    const { createCalendarEvent } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Calendar not found',
    });

    await expect(
      createCalendarEvent({ summary: 'Test', start: new Date(), end: new Date() })
    ).rejects.toThrow('Calendar event creation failed (404)');
  });
});

// ─── Calendar Event Update ──────────────────────────────────────────────────

describe('updateCalendarEvent', () => {
  it('sends PATCH with only provided fields', async () => {
    setupCredentials();
    const { updateCalendarEvent } = await loadModule();

    mockFetch.mockResolvedValueOnce({ ok: true });

    await updateCalendarEvent({
      eventId: 'event-42',
      summary: 'Updated Sprint',
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/events/event-42');
    expect(opts.method).toBe('PATCH');
    const body = JSON.parse(opts.body);
    expect(body.summary).toBe('Updated Sprint');
    expect(body.start).toBeUndefined();
    expect(body.end).toBeUndefined();
  });

  it('throws when Calendar API returns error', async () => {
    setupCredentials();
    const { updateCalendarEvent } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    });

    await expect(
      updateCalendarEvent({ eventId: 'event-42', summary: 'X' })
    ).rejects.toThrow('Calendar event update failed (500)');
  });
});

// ─── Calendar Events List ───────────────────────────────────────────────────

describe('getCalendarEvents', () => {
  it('returns mapped events with id, summary, start, end', async () => {
    setupCredentials();
    const { getCalendarEvents } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            id: 'evt-1',
            summary: 'Morning standup',
            start: { dateTime: '2026-02-19T09:00:00Z' },
            end: { dateTime: '2026-02-19T09:30:00Z' },
          },
          {
            id: 'evt-2',
            summary: 'All-day event',
            start: { date: '2026-02-19' },
            end: { date: '2026-02-20' },
          },
        ],
      }),
    });

    const events = await getCalendarEvents({
      timeMin: new Date('2026-02-19T00:00:00Z'),
      timeMax: new Date('2026-02-20T00:00:00Z'),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: 'evt-1',
      summary: 'Morning standup',
      start: '2026-02-19T09:00:00Z',
      end: '2026-02-19T09:30:00Z',
    });
    // All-day event uses date instead of dateTime
    expect(events[1].start).toBe('2026-02-19');
  });

  it('returns empty array when no items', async () => {
    setupCredentials();
    const { getCalendarEvents } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: undefined }),
    });

    const events = await getCalendarEvents({
      timeMin: new Date(),
      timeMax: new Date(),
    });

    expect(events).toEqual([]);
  });

  it('passes timeMin, timeMax, maxResults, singleEvents, orderBy as query params', async () => {
    setupCredentials();
    const { getCalendarEvents } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await getCalendarEvents({
      timeMin: new Date('2026-02-19T00:00:00Z'),
      timeMax: new Date('2026-02-20T00:00:00Z'),
      maxResults: 10,
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('maxResults')).toBe('10');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('orderBy')).toBe('startTime');
  });

  it('throws when Calendar API returns error', async () => {
    setupCredentials();
    const { getCalendarEvents } = await loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(
      getCalendarEvents({ timeMin: new Date(), timeMax: new Date() })
    ).rejects.toThrow('Calendar events fetch failed (401)');
  });
});
