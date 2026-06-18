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
import { parsePrincipal } from "../../domain/access/principal.ts";
import { type Action, ActionSchema } from "../../domain/access/action.ts";
import { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { parseResourceFlag } from "./access_grant.ts";
import { createAccessCheckRenderer } from "../../presentation/renderers/access_check.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const accessCheckCommand = new Command()
  .name("check")
  .description(
    "Explain whether a subject can perform an action on a resource",
  )
  .example(
    "Check access",
    "swamp access check --subject user:adam --action run --on workflow:@acme/deploy",
  )
  .example(
    "With simulated IdP groups",
    "swamp access check --subject user:adam --action run --on workflow:@acme/deploy --collectives platform-eng,ops",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--subject <subject:string>",
    "Subject to check (e.g. user:adam)",
    { required: true },
  )
  .option(
    "--action <action:string>",
    "Action to check (run, read, write, admin)",
    { required: true },
  )
  .option(
    "--on <resource:string>",
    "Resource to check (e.g. workflow:@acme/deploy)",
    { required: true },
  )
  .option(
    "--collectives <collectives:string>",
    "Comma-separated IdP group memberships to simulate",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "access",
      "check",
    ]);
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    await modelRegistry.ensureLoaded();

    const principal = parsePrincipal(options.subject as string);
    const actionResult = ActionSchema.safeParse(options.action);
    if (!actionResult.success) {
      throw new UserError(
        `Invalid action "${options.action}": must be one of run, read, write, admin`,
      );
    }
    const action: Action = actionResult.data;
    const resource = parseResourceFlag(options.on as string);

    const collectives = options.collectives
      ? (options.collectives as string).split(",").map((c: string) => c.trim())
        .filter((c: string) => c.length > 0)
      : [];

    const eventBus = new EventBus();
    const loader = new PolicySnapshotLoader(
      repoContext.dataQueryService,
      eventBus,
    );

    try {
      const snapshot = await loader.load();
      const service = new GrantBasedAccessDecisionService(snapshot);

      const accessPrincipal = { principal, collectives };
      const accessResource = {
        kind: resource.kind as "workflow" | "model" | "data" | "access",
        name: resource.pattern,
        fields: {},
      };

      const decisions = service.explain(
        accessPrincipal,
        action,
        accessResource,
      );

      const renderer = createAccessCheckRenderer(ctx.outputMode);
      renderer.render({
        subject: options.subject as string,
        action: options.action as string,
        resource: options.on as string,
        collectives,
        decisions,
      });
    } finally {
      loader.dispose();
    }
  });
