export interface ImportArguments {
  since?: Date;
}

// The command line of `npm run import:legacy`: only --since=<date> is accepted, so a typo cannot silently start a
// full import with defaults.
export function parseImportArguments(argv: readonly string[]): ImportArguments {
  const parsed: ImportArguments = {};
  for (const argument of argv) {
    if (argument !== "--since" && !argument.startsWith("--since=")) throw new Error(`Unknown argument: ${argument}`);
    const value = argument.slice("--since=".length);
    if (!value) throw new Error("--since needs a date, for example --since=2026-09-30T00:00:00Z");
    if (parsed.since) throw new Error("--since is given more than once");
    const since = new Date(value);
    if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since date: ${value}`);
    parsed.since = since;
  }
  return parsed;
}
