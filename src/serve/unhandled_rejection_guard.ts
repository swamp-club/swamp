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

const logger = getSwampLogger(["serve", "unhandled-rejection-guard"]);

export interface UnhandledRejectionGuard {
  dispose(): void;
}

/**
 * Installs global `unhandledrejection` and `error` event listeners that
 * prevent the serve process from terminating when extension code produces
 * detached rejecting promises or uncaught exceptions.
 *
 * Call `dispose()` during shutdown to deregister the listeners.
 */
export function installUnhandledRejectionGuard(): UnhandledRejectionGuard {
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    event.preventDefault();
    const reason = event.reason;
    const message = reason instanceof Error
      ? reason.message
      : String(reason ?? "unknown");
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error`Unhandled promise rejection (process kept alive): ${message}`;
    if (stack) {
      logger.debug`${stack}`;
    }
  };

  const onUncaughtError = (event: ErrorEvent): void => {
    event.preventDefault();
    const message = event.error instanceof Error
      ? event.error.message
      : String(event.message ?? "unknown");
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    logger.error`Uncaught error (process kept alive): ${message}`;
    if (stack) {
      logger.debug`${stack}`;
    }
  };

  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);
  globalThis.addEventListener("error", onUncaughtError);

  return {
    dispose() {
      globalThis.removeEventListener(
        "unhandledrejection",
        onUnhandledRejection,
      );
      globalThis.removeEventListener("error", onUncaughtError);
    },
  };
}
