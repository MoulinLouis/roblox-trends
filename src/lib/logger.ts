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
// Messages end up in job_runs, journald and Healthchecks; a validation report on a large payload can reach megabytes.
const maximumMessageLength = 2_000;

// Wrapping errors such as "fetch failed" keep the actionable detail in their cause chain.
export function errorMessage(error: unknown): string {
  const parts = error instanceof Error ? causeChain(error) : [String(error)];
  // An equal share per part, so a huge outer message (a failed bulk query) cannot crowd out the cause.
  const share = Math.floor(maximumMessageLength / parts.length);
  return parts.map((part) => truncate(part, share)).join(": ");
}

function causeChain(error: Error): string[] {
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
  return parts;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(${text.length - limit} more characters)`;
}

// Node reports some connection failures as an AggregateError with an empty message and only a code.
function describeError(error: Error): string {
  if (error.message) return error.message;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error.name;
}
