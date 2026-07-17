export type SessionStatus = "active" | "closed";

export interface Session {
  readonly id: string;
  readonly workspace: string;
  readonly createdAt: number;
  readonly activeRunId: string;
  readonly status: SessionStatus;
}
