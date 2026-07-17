export interface Session {
  readonly id: string;
  readonly createdAt: number;
  readonly eventSchemaVersion: 1;
  readonly evidenceEpoch: string;
}
