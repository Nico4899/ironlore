/**
 * Error thrown when a network request is blocked by egress policy.
 */
export class EgressBlockedError extends Error {
  override readonly name = "EgressBlockedError";
  constructor(
    public readonly projectId: string,
    public readonly host: string,
    public readonly policy: string,
  ) {
    super(
      `Egress blocked: project "${projectId}" cannot reach "${host}" (policy: ${policy})`,
    );
  }
}
