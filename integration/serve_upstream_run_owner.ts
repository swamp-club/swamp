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

// a run owner holding its checkout's writer, as another command does; run in
// its own ProcessRuntime, the test's commands contend with it instead of
// joining its hold

import "../src/domain/models/models.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { endCommand, withClientEnv } from "./serve_upstream_fixtures.ts";
import type { ProcessHost } from "./process_host.ts";

export type RunOwnerRequest =
  | {
    readonly kind: "hold";
    readonly configDir: string;
    readonly repoDir: string;
    readonly env: Record<string, string | undefined>;
  }
  | { readonly kind: "stop" };

export const runOwnerHost: ProcessHost<RunOwnerRequest, string> = (post) => {
  let stop: (() => void) | undefined;
  const hold = async (
    request: Extract<RunOwnerRequest, { kind: "hold" }>,
  ): Promise<void> => {
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
          post("held");
          await stopped;
        } finally {
          await endCommand();
        }
      },
    );
    post("stopped");
  };
  return (request) => {
    if (request.kind === "stop") {
      stop?.();
      return;
    }
    hold(request).catch((error) =>
      post(`failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  };
};
