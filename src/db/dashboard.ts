import { DATABASE_SESSION_CONFIG } from "@/lib/config";
import { type Database, type DatabaseOptions, getDatabase } from "./client";

// Every dashboard transaction starts read-only (the role itself can write: the default is the guard), so a page that
// issues a write by mistake fails instead of changing collected data.
export const DASHBOARD_DATABASE_OPTIONS = {
  applicationName: "radar-web",
  maxConnections: DATABASE_SESSION_CONFIG.dashboardMaxConnections,
  statementTimeoutMs: DATABASE_SESSION_CONFIG.dashboardStatementTimeoutMs,
  lockTimeoutMs: DATABASE_SESSION_CONFIG.dashboardLockTimeoutMs,
  settings: { default_transaction_read_only: "on" },
} as const satisfies DatabaseOptions;

// The dashboard process opens no other database: this is the first and only getDatabase call in radar-web.
export function dashboardDatabase(): Database {
  const { applicationName, ...options } = DASHBOARD_DATABASE_OPTIONS;
  return getDatabase(applicationName, options);
}
