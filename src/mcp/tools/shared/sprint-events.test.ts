import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

vi.mock('../../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { logger } from '../../../config/logger.js';
import {
  recordSprintEvent,
  recordStartEvent,
  recordProgressEvent,
  recordBlockerEvent,
  recordCheckpointEvent,
  recordCompleteEvent,
  loadAllEvents,
  loadPhaseEvents,
  deriveCurrentState,
  getSprintEventLog,
} from './sprint-events.js';
import type { SprintEvent } from './sprint-events.js';

function makeEvent(overrides: Partial<SprintEvent> = {}): SprintEvent {
  return {
    type: 'progress',
    timestamp: '2026-02-28T10:00:00.000Z',
    sprintPhase: 'Phase 92',
    data: { message: 'Completed task' },
    ...overrides,
  };
}

function makeJsonl(events: SprintEvent[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

describe('Sprint Events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  describe('recordSprintEvent', () => {
    it('appends JSON line to the events file', () => {
      const event = makeEvent({ type: 'progress', data: { message: 'done' } });

      recordSprintEvent(event);

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const [path, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(String(path)).toContain('sprint-events.jsonl');
      const parsed = JSON.parse(String(content).trim());
      expect(parsed.type).toBe('progress');
      expect(parsed.data.message).toBe('done');
    });

    it('logs error when append fails', () => {
      vi.mocked(appendFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });

      recordSprintEvent(makeEvent());

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to record sprint event',
        expect.objectContaining({ error: expect.stringContaining('disk full') }),
      );
    });
  });

  describe('recordStartEvent', () => {
    it('creates proper started event shape', () => {
      recordStartEvent('Phase 92', 'Intelligence Wiring', '3 hours');

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const content = String(vi.mocked(appendFileSync).mock.calls[0][1]).trim();
      const parsed = JSON.parse(content);

      expect(parsed.type).toBe('started');
      expect(parsed.sprintPhase).toBe('Phase 92');
      expect(parsed.data.title).toBe('Intelligence Wiring');
      expect(parsed.data.estimate).toBe('3 hours');
      expect(parsed.timestamp).toBeTruthy();
    });

    it('sets estimate to null when not provided', () => {
      recordStartEvent('Phase 92', 'Title');

      const content = String(vi.mocked(appendFileSync).mock.calls[0][1]).trim();
      const parsed = JSON.parse(content);
      expect(parsed.data.estimate).toBeNull();
    });
  });

  describe('recordProgressEvent', () => {
    it('creates proper progress event shape', () => {
      recordProgressEvent('Phase 92', 'Wrote tests');

      const content = String(vi.mocked(appendFileSync).mock.calls[0][1]).trim();
      const parsed = JSON.parse(content);

      expect(parsed.type).toBe('progress');
      expect(parsed.sprintPhase).toBe('Phase 92');
      expect(parsed.data.message).toBe('Wrote tests');
    });
  });

  describe('recordBlockerEvent', () => {
    it('creates proper blocker event shape', () => {
      recordBlockerEvent('Phase 92', 'Build fails');

      const content = String(vi.mocked(appendFileSync).mock.calls[0][1]).trim();
      const parsed = JSON.parse(content);

      expect(parsed.type).toBe('blocker');
      expect(parsed.sprintPhase).toBe('Phase 92');
      expect(parsed.data.description).toBe('Build fails');
    });
  });

  describe('recordCheckpointEvent', () => {
    it('creates proper checkpoint event shape', () => {
      recordCheckpointEvent('Phase 92');

      const content = String(vi.mocked(appendFileSync).mock.calls[0][1]).trim();
      const parsed = JSON.parse(content);

      expect(parsed.type).toBe('checkpoint');
      expect(parsed.sprintPhase).toBe('Phase 92');
      expect(parsed.data).toEqual({});
    });
  });

  describe('recordCompleteEvent', () => {
    it('creates proper completed event shape', () => {
      recordCompleteEvent('Phase 92', 'abc1234', '1.5 hours');

      const content = String(vi.mocked(appendFileSync).mock.calls[0][1]).trim();
      const parsed = JSON.parse(content);

      expect(parsed.type).toBe('completed');
      expect(parsed.sprintPhase).toBe('Phase 92');
      expect(parsed.data.commit).toBe('abc1234');
      expect(parsed.data.actualTime).toBe('1.5 hours');
    });
  });

  describe('loadAllEvents', () => {
    it('returns empty array when file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const events = loadAllEvents();
      expect(events).toEqual([]);
    });

    it('parses JSONL correctly', () => {
      const event1 = makeEvent({ type: 'started', data: { title: 'Test', estimate: null } });
      const event2 = makeEvent({ type: 'progress', data: { message: 'Task 1' } });

      vi.mocked(readFileSync).mockReturnValue(makeJsonl([event1, event2]));

      const events = loadAllEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('started');
      expect(events[1].type).toBe('progress');
    });

    it('handles malformed lines gracefully', () => {
      const valid = makeEvent({ type: 'progress', data: { message: 'ok' } });
      const content = JSON.stringify(valid) + '\n{bad json\n' + JSON.stringify(valid) + '\n';

      vi.mocked(readFileSync).mockReturnValue(content);

      const events = loadAllEvents();
      expect(events).toHaveLength(2);
    });

    it('handles empty file content', () => {
      vi.mocked(readFileSync).mockReturnValue('');

      const events = loadAllEvents();
      expect(events).toEqual([]);
    });

    it('returns empty array on read error', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('permission denied');
      });

      const events = loadAllEvents();
      expect(events).toEqual([]);
    });
  });

  describe('loadPhaseEvents', () => {
    it('filters events by phase', () => {
      const events = [
        makeEvent({ sprintPhase: 'Phase 91', type: 'started', data: { title: 'Old' } }),
        makeEvent({ sprintPhase: 'Phase 92', type: 'started', data: { title: 'New' } }),
        makeEvent({ sprintPhase: 'Phase 92', type: 'progress', data: { message: 'task' } }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const result = loadPhaseEvents('Phase 92');
      expect(result).toHaveLength(2);
      expect(result.every(e => e.sprintPhase === 'Phase 92')).toBe(true);
    });

    it('returns empty array for non-existent phase', () => {
      vi.mocked(readFileSync).mockReturnValue(makeJsonl([makeEvent()]));

      const result = loadPhaseEvents('Phase 999');
      expect(result).toEqual([]);
    });
  });

  describe('deriveCurrentState', () => {
    it('returns idle when no events exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const state = deriveCurrentState();
      expect(state.status).toBe('idle');
      expect(state.phase).toBe('');
      expect(state.title).toBe('');
      expect(state.startedAt).toBeNull();
      expect(state.completedAt).toBeNull();
      expect(state.estimate).toBeNull();
      expect(state.actualTime).toBeNull();
      expect(state.completedTasks).toEqual([]);
      expect(state.blockers).toEqual([]);
      expect(state.checkpoints).toBe(0);
      expect(state.eventCount).toBe(0);
    });

    it('builds state from started event', () => {
      const events = [
        makeEvent({
          type: 'started',
          timestamp: '2026-02-28T08:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { title: 'Intelligence Wiring', estimate: '3 hours' },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const state = deriveCurrentState();
      expect(state.status).toBe('active');
      expect(state.phase).toBe('Phase 92');
      expect(state.title).toBe('Intelligence Wiring');
      expect(state.startedAt).toBe('2026-02-28T08:00:00.000Z');
      expect(state.estimate).toBe('3 hours');
      expect(state.eventCount).toBe(1);
    });

    it('tracks progress, blockers, and checkpoints', () => {
      const events = [
        makeEvent({
          type: 'started',
          timestamp: '2026-02-28T08:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { title: 'Sprint', estimate: '2 hours' },
        }),
        makeEvent({
          type: 'progress',
          timestamp: '2026-02-28T08:30:00.000Z',
          sprintPhase: 'Phase 92',
          data: { message: 'Task 1 done' },
        }),
        makeEvent({
          type: 'blocker',
          timestamp: '2026-02-28T09:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { description: 'CI broken' },
        }),
        makeEvent({
          type: 'checkpoint',
          timestamp: '2026-02-28T09:15:00.000Z',
          sprintPhase: 'Phase 92',
          data: {},
        }),
        makeEvent({
          type: 'progress',
          timestamp: '2026-02-28T09:30:00.000Z',
          sprintPhase: 'Phase 92',
          data: { message: 'Task 2 done' },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const state = deriveCurrentState();
      expect(state.status).toBe('active');
      expect(state.completedTasks).toEqual(['Task 1 done', 'Task 2 done']);
      expect(state.blockers).toHaveLength(1);
      expect(state.blockers[0].description).toBe('CI broken');
      expect(state.blockers[0].resolved).toBe(false);
      expect(state.checkpoints).toBe(1);
      expect(state.eventCount).toBe(5);
    });

    it('marks completed with actualTime', () => {
      const events = [
        makeEvent({
          type: 'started',
          timestamp: '2026-02-28T08:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { title: 'Sprint', estimate: '2 hours' },
        }),
        makeEvent({
          type: 'completed',
          timestamp: '2026-02-28T09:30:00.000Z',
          sprintPhase: 'Phase 92',
          data: { commit: 'abc1234', actualTime: '1.5 hours' },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const state = deriveCurrentState();
      expect(state.status).toBe('completed');
      expect(state.completedAt).toBe('2026-02-28T09:30:00.000Z');
      expect(state.actualTime).toBe('1.5 hours');
    });

    it('handles blocker resolution', () => {
      const events = [
        makeEvent({
          type: 'started',
          timestamp: '2026-02-28T08:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { title: 'Sprint', estimate: null },
        }),
        makeEvent({
          type: 'blocker',
          timestamp: '2026-02-28T08:30:00.000Z',
          sprintPhase: 'Phase 92',
          data: { description: 'CI broken' },
        }),
        makeEvent({
          type: 'blocker_resolved',
          timestamp: '2026-02-28T09:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { description: 'CI broken' },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const state = deriveCurrentState();
      expect(state.blockers).toHaveLength(1);
      expect(state.blockers[0].resolved).toBe(true);
      expect(state.blockers[0].resolvedAt).toBe('2026-02-28T09:00:00.000Z');
    });

    it('uses the most recent started event as current sprint', () => {
      const events = [
        makeEvent({
          type: 'started',
          timestamp: '2026-02-27T08:00:00.000Z',
          sprintPhase: 'Phase 91',
          data: { title: 'Old Sprint', estimate: null },
        }),
        makeEvent({
          type: 'completed',
          timestamp: '2026-02-27T10:00:00.000Z',
          sprintPhase: 'Phase 91',
          data: { commit: 'old123', actualTime: '2 hours' },
        }),
        makeEvent({
          type: 'started',
          timestamp: '2026-02-28T08:00:00.000Z',
          sprintPhase: 'Phase 92',
          data: { title: 'New Sprint', estimate: '1 hour' },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const state = deriveCurrentState();
      expect(state.phase).toBe('Phase 92');
      expect(state.title).toBe('New Sprint');
      expect(state.status).toBe('active');
      expect(state.eventCount).toBe(1);
    });
  });

  describe('getSprintEventLog', () => {
    it('formats events as text with timestamps', () => {
      const events = [
        makeEvent({
          type: 'started',
          timestamp: '2026-02-28T08:15:00.000Z',
          sprintPhase: 'Phase 92',
          data: { title: 'Sprint', estimate: '2 hours' },
        }),
        makeEvent({
          type: 'progress',
          timestamp: '2026-02-28T09:30:00.000Z',
          sprintPhase: 'Phase 92',
          data: { message: 'Wrote tests for events' },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const log = getSprintEventLog('Phase 92');

      expect(log).toContain('[08:15] started:');
      expect(log).toContain('title=Sprint');
      expect(log).toContain('[09:30] progress:');
      expect(log).toContain('message=Wrote tests for events');
    });

    it('returns empty string for non-existent phase', () => {
      vi.mocked(readFileSync).mockReturnValue(makeJsonl([makeEvent()]));

      const log = getSprintEventLog('Phase 999');
      expect(log).toBe('');
    });

    it('truncates long data values', () => {
      const longMessage = 'A'.repeat(200);
      const events = [
        makeEvent({
          type: 'progress',
          sprintPhase: 'Phase 92',
          data: { message: longMessage },
        }),
      ];
      vi.mocked(readFileSync).mockReturnValue(makeJsonl(events));

      const log = getSprintEventLog('Phase 92');
      // Data values are truncated to 80 chars
      expect(log.length).toBeLessThan(200);
    });
  });
});
