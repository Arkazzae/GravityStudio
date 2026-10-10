/** Reserved server wall time, with overlapping tasks charged once per user. */
export interface WorkTimeBalance {
  userId: string;
  unlimited: boolean;
  grantedMs: number;
  usedMs: number;
  remainingMs: number;
  activeTasks: number;
  /** Interrupted durable tasks retain their resource reservation and clock. */
  uncertainTasks: number;
  sampledAt: number;
  /** No earlier usage is inferred from historical job timestamps. */
  trackedSince: number | null;
}

export interface WorkTimeSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
}

export interface WorkTimeAdjustment {
  id: string;
  userId: string;
  actorId: string;
  amountMs: number;
  reason: string;
  createdAt: number;
}

export interface WorkTimeDetails {
  balance: WorkTimeBalance;
  sessions: WorkTimeSession[];
  adjustments: WorkTimeAdjustment[];
}

export interface WorkTimeUser {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "suspended" | "deleting" | "deleted";
  balance: WorkTimeBalance;
}

export type WorkTimeTaskKind = "job" | "local-llm" | "supporting";
