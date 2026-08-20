import fs from 'node:fs';

export interface ConnectorWorkerConfig {
  contextHubUrl: string;
  contextHubKeyFile: string;
  checkpointSchemaId: string;
}

export function read0600Secret(file: string): string {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`secret file must be mode 0600: ${file}`);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`secret file is empty: ${file}`);
  return value;
}

export function readWorkerConfig(file: string): ConnectorWorkerConfig {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ConnectorWorkerConfig>;
  if (!parsed.contextHubUrl || !/^https?:\/\//.test(parsed.contextHubUrl)) throw new Error('connector contextHubUrl must be http(s)');
  if (!parsed.contextHubKeyFile || !parsed.checkpointSchemaId) throw new Error('connector worker config is incomplete');
  return { contextHubUrl: parsed.contextHubUrl, contextHubKeyFile: parsed.contextHubKeyFile, checkpointSchemaId: parsed.checkpointSchemaId };
}
