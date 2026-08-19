import type { ConnectorItem } from './sdk.js';

export interface CalendarEventFixture { id: string; summary?: string; start?: { dateTime?: string; date?: string; timeZone?: string }; end?: { dateTime?: string; date?: string; timeZone?: string }; status?: string; updated?: string; recurrence?: string[]; htmlLink?: string; recurringEventId?: string }

/** Maps only the Calendar allowlist; descriptions, attendees, locations and
 * conference data are intentionally dropped before leaving the connector. */
export function mapCalendarEvent(event: CalendarEventFixture, calendarId: string): ConnectorItem {
  const start = event.start?.dateTime ?? event.start?.date ?? '';
  const end = event.end?.dateTime ?? event.end?.date ?? '';
  return { type: 'calendar_event', title: event.summary?.trim() || '(untitled event)', content: '', status: event.status === 'cancelled' ? 'cancelled' : 'active', data: { calendar_id: calendarId, start, end, all_day: Boolean(event.start?.date && !event.start?.dateTime), status: event.status ?? 'confirmed', updated: event.updated ?? null, recurrence_id: event.recurringEventId ?? null }, source_item_id: `${calendarId}:${event.id}`, source_uri: event.htmlLink, idempotency_key: `calendar:${calendarId}:${event.id}:${event.updated ?? ''}` };
}

export interface CalendarSyncState { syncToken?: string; fullReconcileRequired: boolean }
export function handleCalendarSyncTokenInvalid(): CalendarSyncState { return { fullReconcileRequired: true }; }
