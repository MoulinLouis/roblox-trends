type LogDetails = Record<string, unknown>;

function write(level: "info" | "warn" | "error", message: string, details?: LogDetails): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(details ? { details } : {}),
  };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const logger = {
  info: (message: string, details?: LogDetails) => write("info", message, details),
  warn: (message: string, details?: LogDetails) => write("warn", message, details),
  error: (message: string, details?: LogDetails) => write("error", message, details),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
