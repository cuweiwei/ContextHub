import fs from 'node:fs';
import { syncGoogleCalendar } from './google-calendar-worker.js';
import { read0600Secret, readWorkerConfig } from './worker-config.js';

const configPath = process.env.GOOGLE_CALENDAR_CONNECTOR_CONFIG_FILE ?? '/etc/contexthub/connectors/google-calendar.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { calendars?: string[]; api_base_url?: string; page_size?: number };
const base = readWorkerConfig(configPath);
const calendars = config.calendars ?? [];
if (calendars.length === 0 || calendars.some((calendar) => !calendar || calendar.length > 200 || /[\r\n]/.test(calendar))) throw new Error('Google Calendar connector calendars must be explicit allowlist entries');
const results = await syncGoogleCalendar({
  ...base,
  contextHubApiKey: read0600Secret(base.contextHubKeyFile),
  accessToken: read0600Secret(process.env.GOOGLE_CALENDAR_ACCESS_TOKEN_FILE ?? '/run/secrets/google-calendar-token'),
  calendars,
  apiBaseUrl: config.api_base_url,
  pageSize: config.page_size,
});
console.log(JSON.stringify({ connector: 'google-calendar', results: results.map(({ connector, status, pages, items, checkpointValue, error_code }) => ({ connector, status, pages, items, checkpointValue, error_code })) }));
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
