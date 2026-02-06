/**
 * Base error for user-facing errors that should not show a stack trace.
 * Use this for validation errors, "model not found" messages, and other
 * expected error conditions where the stack trace would be noise.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
