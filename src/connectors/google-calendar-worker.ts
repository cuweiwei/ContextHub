import { ConnectorRestClient } from './sdk.js';
import { mapCalendarEvent, handleCalendarSyncTokenInvalid, type CalendarEventFixture } from './google-calendar.js';
import { runConnectorWorker, type ConnectorPage, type ConnectorWorkerResult } from './worker-runtime.js';
import type { ConnectorWorkerConfig } from './worker-config.js';

export interface GoogleCalendarWorkerOptions extends ConnectorWorkerConfig {
  accessToken: string;
  contextHubApiKey: string;
  calendars: string[];
  apiBaseUrl?: string;
  pageSize?: number;
}

interface CalendarCursor { syncToken?: string; pageToken?: string; fullReconcile?: boolean }
interface CalendarPage { items?: CalendarEventFixture[]; nextPageToken?: string; nextSyncToken?: string }

function decodeCursor(cursor: string | null): CalendarCursor {
  if (!cursor) return {};
  try { return JSON.parse(cursor) as CalendarCursor; } catch { return { syncToken: cursor }; }
}

function apiError(status: number): Error { return new Error(`calendar_http_${status}`); }

async function fetchCalendarPage(options: GoogleCalendarWorkerOptions, calendarId: string, cursor: string | null): Promise<ConnectorPage<CalendarEventFixture>> {
  const state = decodeCursor(cursor);
  const url = new URL(`${options.apiBaseUrl ?? 'https://www.googleapis.com/calendar/v3'}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('singleEvents', 'false');
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('maxResults', String(options.pageSize ?? 250));
  if (state.pageToken) url.searchParams.set('pageToken', state.pageToken);
  else if (state.syncToken) url.searchParams.set('syncToken', state.syncToken);
  if (state.fullReconcile) url.searchParams.set('timeMin', new Date(0).toISOString());
  const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${options.accessToken}` } });
  if (!response.ok) throw apiError(response.status);
  const body = await response.json() as CalendarPage;
  const items = Array.isArray(body.items) ? body.items : [];
  const nextCursor = body.nextPageToken ? JSON.stringify({ syncToken: state.syncToken, pageToken: body.nextPageToken, fullReconcile: state.fullReconcile }) : null;
  const checkpoint = body.nextPageToken
    ? JSON.stringify({ syncToken: state.syncToken, pageToken: body.nextPageToken, fullReconcile: state.fullReconcile })
    : JSON.stringify({ syncToken: body.nextSyncToken ?? state.syncToken ?? null, fullReconcile: false });
  return { items, nextCursor, complete: !body.nextPageToken, checkpointValue: checkpoint };
}

async function syncCalendarOnce(options: GoogleCalendarWorkerOptions, calendarId: string, initialCursor: string | null, fullReconcile = false): Promise<ConnectorWorkerResult> {
  const client = new ConnectorRestClient(options.contextHubUrl, options.contextHubApiKey);
  const stateKey = `connector.calendar:${calendarId}`;
  const state = await client.getOperationalState(stateKey).catch(() => ({ value: null, revision: null }));
  const stateValue = state.value && typeof state.value === 'object' ? state.value as { sync_token?: string; full_reconcile?: boolean } : undefined;
  const cursor = initialCursor ?? (fullReconcile
    ? JSON.stringify({ fullReconcile: true })
    : (stateValue?.sync_token ? JSON.stringify({ syncToken: stateValue.sync_token, fullReconcile: stateValue.full_reconcile }) : null));
  return runConnectorWorker({
    connector: `calendar:${calendarId}`,
    checkpointKey: `calendar:${calendarId}`,
    client,
    initialCursor: cursor,
    fetchPage: (next) => fetchCalendarPage(options, calendarId, next),
    map: (event) => mapCalendarEvent(event, calendarId),
    loadCheckpoint: async () => cursor,
    saveCheckpoint: async (value) => {
      const parsed = value ? decodeCursor(value) : {};
      await client.putOperationalState(stateKey, { sync_token: parsed.syncToken ?? null, full_reconcile: false }, options.checkpointSchemaId, typeof state.revision === 'number' ? state.revision : null, `calendar:checkpoint:${calendarId}:${parsed.syncToken ?? 'none'}`);
    },
  });
}

export async function syncGoogleCalendar(options: GoogleCalendarWorkerOptions): Promise<ConnectorWorkerResult[]> {
  const results: ConnectorWorkerResult[] = [];
  for (const calendarId of options.calendars) {
    let result = await syncCalendarOnce(options, calendarId, null);
    if (result.error_code?.startsWith('calendar_http_410')) {
      handleCalendarSyncTokenInvalid();
      result = await syncCalendarOnce(options, calendarId, null, true);
    }
    results.push(result);
  }
  return results;
}
