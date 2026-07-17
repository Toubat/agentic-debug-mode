export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProbeEvent {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  hypothesisId: string;
  timestamp: number;
  location: string;
  message: string;
  data: JsonValue;
  id?: string;
}

export interface NormalizedEvent extends Omit<ProbeEvent, "id"> {
  id: string;
  sequence: number;
  receivedAt: number;
}
