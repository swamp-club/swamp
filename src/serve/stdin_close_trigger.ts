// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

/**
 * A stdin that cannot be opened or read counts as closed: the parent holding
 * the pipe can no longer be heard. The returned promise never rejects.
 */
export async function watchStdinClose(
  openStream: () => ReadableStream<Uint8Array>,
  onClose: () => Promise<void> | void,
): Promise<void> {
  try {
    for await (const _ of openStream()) { /* nothing to read */ }
    logger.info("Stdin closed, shutting down");
  } catch (error) {
    logger.warn("Could not read stdin, shutting down: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await onClose();
  } catch (error) {
    logger.error("Shutdown error: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** without the flag stdin is never opened, so a serve on a terminal or under a service manager is unchanged */
export function stdinShutdownTrigger(
  enabled: boolean,
  openStream: () => ReadableStream<Uint8Array>,
  startShutdown: () => Promise<void>,
): Promise<void> | undefined {
  if (!enabled) return undefined;
  return watchStdinClose(openStream, startShutdown);
}
