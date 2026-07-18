export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProbeEvent {
  hypothesisId: string;
  timestamp: number;
  location: string;
  message: string;
  data: JsonValue;
}

export interface NormalizedEvent extends ProbeEvent {
  id: string;
  sequence: number;
  receivedAt: number;
}
