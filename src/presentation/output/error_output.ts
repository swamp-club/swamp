import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

const logger = getSwampLogger(["error"]);

/**
 * Renders an error via LogTape at fatal level.
 * UserError instances log just the message (no stack trace).
 * Other errors log the full Error object (including stack trace via Deno.inspect).
 */
export function renderError(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));

  if (err instanceof UserError) {
    logger.fatal("Error: {message}", { message: err.message });
  } else {
    logger.fatal("{error}", { error: err });
  }
}
