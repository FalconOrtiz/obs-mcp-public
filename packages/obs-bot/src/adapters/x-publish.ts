/** Posting to X is unreachable from this build. A later change has to land after the owner approves it. */
export class XApprovalRequired extends Error {
  constructor() {
    super("X draft was not posted. Auto-post stays off until a later change after X approval.");
  }
}

export function publishXDraft(_draft?: unknown): never {
  throw new XApprovalRequired();
}
