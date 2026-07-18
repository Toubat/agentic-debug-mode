export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_SCHEMA_VERSION = 1;

export interface DaemonProcessIdentity {
  executable?: string;
  startTime?: number;
}

export interface DaemonMetadata {
  schemaVersion: 1;
  protocolVersion: 1;
  binaryVersion: string;
  host: typeof DAEMON_HOST;
  port: number;
  pid: number;
  processIdentity: DaemonProcessIdentity;
  nonce: string;
  startedAt: number;
  activeSessions?: number;
}

export interface DaemonConnection extends DaemonMetadata {
  controlToken: string;
}
