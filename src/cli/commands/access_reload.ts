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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { validateServerRepoExclusivity } from "./access_helpers.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
} from "../../cli/remote_run.ts";
import type { AccessReloadResponse } from "../../serve/protocol.ts";
import { createAccessReloadRenderer } from "../../presentation/renderers/access_reload.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const accessReloadCommand = new Command()
  .name("reload")
  .description(
    "Rebuild the policy snapshot from current grants and groups",
  )
  .example(
    "Reload on a remote server",
    "swamp access reload --server wss://swamp.acme.internal:9090",
  )
  .example("Reload locally", "swamp access reload")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--server <url:string>",
    "Reload access policy on a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token (falls back to stored credential)",
  )
  .action(async function (options: AnyOptions) {
    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    const ctx = createContext(options as GlobalOptions, [
      "access",
      "reload",
    ]);

    const renderer = createAccessReloadRenderer(ctx.outputMode);

    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );

      const response = await requestServerResponse<AccessReloadResponse>(
        { server, ...(token ? { token } : {}) },
        { type: "access.reload" },
      );

      if (!response.success) {
        throw new UserError("Policy reload failed on the server");
      }

      renderer.render({
        success: true,
        grantCount: response.grantCount,
        groupCount: response.groupCount,
      });
      return;
    }

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    await modelRegistry.ensureLoaded();

    const eventBus = new EventBus();
    const loader = new PolicySnapshotLoader(
      repoContext.dataQueryService,
      eventBus,
      "manual",
    );

    try {
      const result = await loader.loadWithCounts();
      renderer.render({
        success: true,
        grantCount: result.grantCount,
        groupCount: result.groupCount,
      });
    } finally {
      await loader.dispose();
    }
  });
