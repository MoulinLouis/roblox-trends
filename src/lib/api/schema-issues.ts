// "path: message", or the message alone when the issue concerns the value itself.
export function describeIssue(issue: { path: readonly PropertyKey[]; message: string }): string {
  return issue.path.length ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message;
}
