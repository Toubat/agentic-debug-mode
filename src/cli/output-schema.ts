export interface Warning {
  code: string;
  message: string;
}

export interface Hint {
  action: string;
  message: string;
  command?: string;
}

export interface CommandScope {
  hypothesisFilter?: string[] | null;
  hypothesisIds?: string[];
  runId?: string;
  sessionId?: string;
}

export interface CommandResult<TData = unknown> {
  schemaVersion: 1;
  ok: true;
  partial: boolean;
  command: string;
  scope: CommandScope;
  warnings: Warning[];
  statistics: Record<string, number | string | boolean | null>;
  data: TData;
  hints: Hint[];
}

export interface CommandErrorDetail {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

export interface CommandError {
  schemaVersion: 1;
  ok: false;
  error: CommandErrorDetail;
}

export type CommandOutput<TData = unknown> = CommandResult<TData> | CommandError;
