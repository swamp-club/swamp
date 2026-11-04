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

// a Worker has its own module state, so the test's process does not join its hold

import "../src/domain/models/models.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { endCommand, withClientEnv } from "./serve_upstream_fixtures.ts";

export type RunOwnerRequest =
  | {
    readonly kind: "hold";
    readonly configDir: string;
    readonly repoDir: string;
    readonly env: Record<string, string | undefined>;
  }
  | { readonly kind: "stop" };

declare const self: Worker;

const logging = initializeLogging({});
let stop: (() => void) | undefined;

async function hold(
  request: Extract<RunOwnerRequest, { kind: "hold" }>,
): Promise<void> {
  await logging;
  await withClientEnv(
    { configDir: request.configDir },
    request.env,
    ["workflow", "run"],
    async () => {
      try {
        await requireInitializedRepoUnlocked({
          repoDir: request.repoDir,
          outputMode: "json",
        });
        const stopped = new Promise<void>((resolve) => stop = resolve);
        self.postMessage("held");
        await stopped;
      } finally {
        await endCommand();
      }
    },
  );
  self.postMessage("stopped");
}

self.onmessage = (event: MessageEvent<RunOwnerRequest>) => {
  if (event.data.kind === "stop") {
    stop?.();
    return;
  }
  hold(event.data).catch((error) =>
    self.postMessage(
      `failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  );
};

self.postMessage("loaded");
