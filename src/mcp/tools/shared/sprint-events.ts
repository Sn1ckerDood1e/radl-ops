/**
 * Event-Sourced Sprint State
 *
 * Append-only event log for sprint lifecycle events.
 * Coexists with the existing sprint.sh JSON-based state.
 * Provides full audit trail and crash-recovery via event replay.
 *
 * Events are stored in sprint-events.jsonl (one JSON object per line).
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../config/logger.js';
import { getConfig } from '../../../config/paths.js';

// ============================================
// Types
// ============================================

export type SprintEventType =
  | 'started'
  | 'progress'
  | 'blocker'
  | 'blocker_resolved'
  | 'checkpoint'
  | 'completed';

export interface SprintEvent {
  type: SprintEventType;
  timestamp: string;
  sprintPhase: string;
  data: Record<string, unknown>;
}

export interface DerivedSprintState {
  phase: string;
  title: string;
  status: 'idle' | 'active' | 'completed';
  startedAt: string | null;
  completedAt: string | null;
  estimate: string | null;
  actualTime: string | null;
  completedTasks: string[];
  blockers: Array<{ description: string; resolved: boolean; resolvedAt?: string }>;
  checkpoints: number;
  eventCount: number;
}

// ============================================
// Event Storage
// ============================================

function getEventsPath(): string {
  const knowledgeDir = getConfig().knowledgeDir;
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
  }
  return join(knowledgeDir, 'sprint-events.jsonl');
}

/**
 * Append a sprint event to the event log.
 */
export function recordSprintEvent(event: SprintEvent): void {
  try {
    const line = JSON.stringify(event) + '\n';
    appendFileSync(getEventsPath(), line);
    logger.debug('Sprint event recorded', { type: event.type, phase: event.sprintPhase });
  } catch (error) {
    logger.error('Failed to record sprint event', { error: String(error) });
  }
}

/**
 * Convenience helpers for common events.
 */
export function recordStartEvent(phase: string, title: string, estimate?: string): void {
  recordSprintEvent({
    type: 'started',
    timestamp: new Date().toISOString(),
    sprintPhase: phase,
    data: { title, estimate: estimate ?? null },
  });
}

export function recordProgressEvent(phase: string, message: string): void {
  recordSprintEvent({
    type: 'progress',
    timestamp: new Date().toISOString(),
    sprintPhase: phase,
    data: { message },
  });
}

export function recordBlockerEvent(phase: string, description: string): void {
  recordSprintEvent({
    type: 'blocker',
    timestamp: new Date().toISOString(),
    sprintPhase: phase,
    data: { description },
  });
}

export function recordCheckpointEvent(phase: string): void {
  recordSprintEvent({
    type: 'checkpoint',
    timestamp: new Date().toISOString(),
    sprintPhase: phase,
    data: {},
  });
}

export function recordCompleteEvent(phase: string, commit: string, actualTime: string): void {
  recordSprintEvent({
    type: 'completed',
    timestamp: new Date().toISOString(),
    sprintPhase: phase,
    data: { commit, actualTime },
  });
}

// ============================================
// Event Replay (Derive State)
// ============================================

/**
 * Load all events from the event log.
 */
export function loadAllEvents(): SprintEvent[] {
  const eventsPath = getEventsPath();
  if (!existsSync(eventsPath)) return [];

  try {
    const content = readFileSync(eventsPath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as SprintEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is SprintEvent => e !== null);
  } catch (error) {
    logger.error('Failed to load sprint events', { error: String(error) });
    return [];
  }
}

/**
 * Load events for a specific sprint phase.
 */
export function loadPhaseEvents(phase: string): SprintEvent[] {
  return loadAllEvents().filter(e => e.sprintPhase === phase);
}

/**
 * Derive current sprint state by replaying events.
 * Finds the most recent sprint (last 'started' event) and projects state.
 */
export function deriveCurrentState(): DerivedSprintState {
  const events = loadAllEvents();

  // Find the last 'started' event
  let lastStartIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'started') {
      lastStartIdx = i;
      break;
    }
  }

  if (lastStartIdx === -1) {
    return {
      phase: '',
      title: '',
      status: 'idle',
      startedAt: null,
      completedAt: null,
      estimate: null,
      actualTime: null,
      completedTasks: [],
      blockers: [],
      checkpoints: 0,
      eventCount: 0,
    };
  }

  const startEvent = events[lastStartIdx];
  const sprintEvents = events.slice(lastStartIdx);

  const state: DerivedSprintState = {
    phase: startEvent.sprintPhase,
    title: String(startEvent.data.title ?? ''),
    status: 'active',
    startedAt: startEvent.timestamp,
    completedAt: null,
    estimate: startEvent.data.estimate ? String(startEvent.data.estimate) : null,
    actualTime: null,
    completedTasks: [],
    blockers: [],
    checkpoints: 0,
    eventCount: sprintEvents.length,
  };

  for (const event of sprintEvents) {
    switch (event.type) {
      case 'progress':
        state.completedTasks = [...state.completedTasks, String(event.data.message ?? '')];
        break;
      case 'blocker':
        state.blockers = [...state.blockers, { description: String(event.data.description ?? ''), resolved: false }];
        break;
      case 'blocker_resolved': {
        const desc = String(event.data.description ?? '');
        state.blockers = state.blockers.map(b =>
          b.description === desc ? { ...b, resolved: true, resolvedAt: event.timestamp } : b
        );
        break;
      }
      case 'checkpoint':
        state.checkpoints = state.checkpoints + 1;
        break;
      case 'completed':
        state.status = 'completed';
        state.completedAt = event.timestamp;
        state.actualTime = event.data.actualTime ? String(event.data.actualTime) : null;
        break;
    }
  }

  return state;
}

/**
 * Get events for the Bloom pipeline (richer input data).
 * Returns formatted event log for the most recent sprint.
 */
export function getSprintEventLog(phase: string): string {
  const events = loadPhaseEvents(phase);
  if (events.length === 0) return '';

  return events.map(e => {
    const ts = e.timestamp.split('T')[1]?.substring(0, 5) ?? '';
    const dataStr = Object.entries(e.data)
      .map(([k, v]) => `${k}=${String(v).substring(0, 80)}`)
      .join(', ');
    return `[${ts}] ${e.type}: ${dataStr}`;
  }).join('\n');
}
