import type { DB } from '../db/connection.js';

export function createClientActivityRepo(db: DB) {
  const upsert = db.prepare(
    `INSERT INTO client_activity (client_id, last_authenticated_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET last_authenticated_at = excluded.last_authenticated_at, updated_at = excluded.updated_at`,
  );
  function authenticated(clientId: string): void {
    const now = new Date().toISOString();
    const previous = db.prepare('SELECT updated_at FROM client_activity WHERE client_id = ?').get(clientId) as { updated_at: string } | undefined;
    if (previous && Date.now() - Date.parse(previous.updated_at) < 30_000) return;
    upsert.run(clientId, now, now);
  }
  function mcpInitialize(clientId: string): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO client_activity (client_id, last_mcp_initialize_at, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET last_mcp_initialize_at = excluded.last_mcp_initialize_at, updated_at = excluded.updated_at`).run(clientId, now, now);
  }
  function toolCall(clientId: string, toolName: string): void {
    const now = new Date().toISOString();
    const previous = db.prepare('SELECT updated_at FROM client_activity WHERE client_id = ?').get(clientId) as { updated_at: string } | undefined;
    if (previous && Date.now() - Date.parse(previous.updated_at) < 30_000) return;
    db.prepare(`INSERT INTO client_activity (client_id, last_tool_call_at, last_tool_name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET last_tool_call_at = excluded.last_tool_call_at, last_tool_name = excluded.last_tool_name, updated_at = excluded.updated_at`).run(clientId, now, toolName, now);
  }
  function authError(clientId: string, code: string): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO client_activity (client_id, last_auth_error_at, last_auth_error_code, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET last_auth_error_at = excluded.last_auth_error_at, last_auth_error_code = excluded.last_auth_error_code, updated_at = excluded.updated_at`).run(clientId, now, code, now);
  }
  function get(clientId: string) { return db.prepare('SELECT * FROM client_activity WHERE client_id = ?').get(clientId) ?? null; }
  return { authenticated, mcpInitialize, toolCall, authError, get };
}

export type ClientActivityRepo = ReturnType<typeof createClientActivityRepo>;
