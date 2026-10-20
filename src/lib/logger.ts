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

const maximumCauseDepth = 5;

// Wrapping errors such as "fetch failed" keep the actionable detail in their cause chain.
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [describeError(error)];
  let cause = error.cause;
  for (let depth = 0; depth < maximumCauseDepth && cause != null; depth += 1) {
    if (!(cause instanceof Error)) {
      parts.push(String(cause));
      break;
    }
    parts.push(describeError(cause));
    cause = cause.cause;
  }
  return parts.join(": ");
}

// Node reports some connection failures as an AggregateError with an empty message and only a code.
function describeError(error: Error): string {
  if (error.message) return error.message;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error.name;
}
