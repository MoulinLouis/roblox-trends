const strictSslModes = new Set(["prefer", "require", "verify-ca"]);

export function normalizePostgresConnectionUrl(connectionUrl: string): string {
  return connectionUrl.replace(
    /([?&]sslmode=)([^&#]*)/i,
    (match, prefix: string, sslMode: string) =>
      strictSslModes.has(sslMode.toLowerCase()) ? `${prefix}verify-full` : match,
  );
}
