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

import { explainedForAction } from "../../domain/access/access_resources.ts";
import { clientToString, parseClient } from "../../domain/access/client.ts";
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
import {
  type Action,
  ACTION_LIST,
  ActionSchema,
} from "../../domain/access/action.ts";
import { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { explainedAccessResource } from "../../libswamp/access/explained_resource.ts";
import {
  parseFieldFlags,
  parseResourceFlag,
  validateServerRepoExclusivity,
} from "./access_helpers.ts";
import {
  canonicalResourceSelectorString,
  resourceSelectorToString,
} from "../../domain/access/resource_selector.ts";
import { createAccessCheckRenderer } from "../../presentation/renderers/access_check.ts";
import {
  CA_CERT_DESCRIPTION,
  CA_CERT_FLAG,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  TOKEN_FILE_DESCRIPTION,
} from "../../cli/remote_run.ts";
import type { AccessCheckResponse } from "../../serve/protocol.ts";
import type { AccessCheckResult } from "../../presentation/renderers/access_check.ts";

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
    "swamp access check --subject user:adam --action run --on workflow:@acme/deploy --groups platform-eng,ops",
  )
  .example(
    "With resource fields for condition evaluation",
    "swamp access check --subject user:adam --action run --on workflow:@acme/deploy --field tags.env=staging",
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
    `Action to check (${ACTION_LIST})`,
    { required: true },
  )
  .option(
    "--on <resource:string>",
    "Resource to check (e.g. workflow:@acme/deploy)",
    { required: true },
  )
  .option(
    "--method <method:string>",
    "Method to check against method-scoped grants: a behavior method, or a vault verb such as get or put",
  )
  .option(
    "--client <client:string>",
    "Client to simulate for CEL conditions on client, as <kind>:<id>; omitted reads as direct; local checks only",
  )
  .option(
    "--collectives <collectives:string>",
    "Comma-separated collective memberships to simulate for collective: grants and CEL conditions (principal.collectives)",
  )
  .option(
    "--groups <groups:string>",
    "Comma-separated IdP group memberships to simulate for idp-group: grants",
  )
  .option(
    "--field <field:string>",
    "Resource field for condition evaluation (key=value, repeatable); overrides the field resolved from the repo",
    { collect: true },
  )
  .option(
    "--server <url:string>",
    "Check access on a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token; only applies with --server (falls back to stored credential or SWAMP_SERVER_TOKEN)",
  )
  .option(
    "--token-file <path:string>",
    TOKEN_FILE_DESCRIPTION,
  )
  .option(CA_CERT_FLAG, CA_CERT_DESCRIPTION)
  .action(async function (options: AnyOptions) {
    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    if (server) {
      if (options.field && (options.field as string[]).length > 0) {
        throw new UserError(
          "--field is not supported with --server: the server evaluates conditions against its own resource context",
        );
      }
      if (options.client !== undefined) {
        throw new UserError(
          "--client is not supported with --server: the server reads the client from the caller's own session and a request cannot name one; check locally with --client",
        );
      }
      if (options.groups) {
        throw new UserError(
          "--groups is not supported with --server: the server uses the caller's own session for a self-check and knows no IdP groups for another subject; check locally with --groups",
        );
      }
      if (options.collectives) {
        throw new UserError(
          "--collectives is not supported with --server: the server uses the caller's own session for a self-check and knows no collectives for another subject; check locally with --collectives",
        );
      }

      const ctx = createContext(options as GlobalOptions, [
        "access",
        "check",
      ]);

      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );

      const response = await requestServerResponse<AccessCheckResponse>(
        { server, ...(token ? { token } : {}) },
        {
          type: "access.check",
          payload: {
            subject: options.subject as string,
            action: options.action as string,
            // sent in the canonical spelling so a server that predates the
            // behavior spelling still reads it.
            resource: canonicalResourceSelectorString(options.on as string),
            ...(options.method ? { method: options.method as string } : {}),
          },
        },
      );

      const result = response as unknown as AccessCheckResult;
      if (options.method && result.method === undefined) {
        ctx.logger.warn(
          "The server predates --method, so it checked {resource} without a method",
          { resource: options.on as string },
        );
      }
      const renderer = createAccessCheckRenderer(ctx.outputMode);
      renderer.render(result);

      const isDenied = result.decisions.length === 0 ||
        result.decisions[0].effect === "deny";
      if (isDenied) Deno.exitCode = 1;
      return;
    }

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
        `Invalid action "${options.action}": must be one of ${ACTION_LIST}`,
      );
    }
    const action: Action = actionResult.data;
    let client: string | undefined;
    if (options.client !== undefined) {
      try {
        client = clientToString(parseClient(options.client as string));
      } catch (error) {
        throw new UserError((error as Error).message);
      }
    }
    const resource = parseResourceFlag(options.on as string);

    const collectives = options.collectives
      ? (options.collectives as string).split(",").map((c: string) => c.trim())
        .filter((c: string) => c.length > 0)
      : [];

    const groups = options.groups
      ? (options.groups as string).split(",").map((g: string) => g.trim())
        .filter((g: string) => g.length > 0)
      : [];

    const eventBus = new EventBus();
    const loader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      eventBus,
    );

    try {
      const snapshot = await loader.load();
      const service = new GrantBasedAccessDecisionService(snapshot);

      const accessPrincipal = {
        principal,
        collectives,
        groups,
        client,
      };
      // resolve the resource from the repo as serve does, so a grant on its
      // stored type or a condition on its tags applies.
      const accessResource = await explainedAccessResource(
        repoContext,
        resource.kind,
        resource.pattern,
        {
          ...parseFieldFlags(options.field as string[] | undefined),
          ...(options.method ? { methodName: options.method as string } : {}),
        },
        (error) => {
          ctx.logger.warn(
            "Could not look up {resource}; checking it by name only: {error}",
            {
              resource: options.on as string,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        },
      );

      const decisions = service.explain(
        accessPrincipal,
        action,
        explainedForAction(accessResource, action),
      );

      const result = {
        subject: options.subject as string,
        action: options.action as string,
        resource: resourceSelectorToString(resource),
        collectives,
        decisions,
        ...(options.method ? { method: options.method as string } : {}),
        ...(client !== undefined ? { client } : {}),
      };

      const renderer = createAccessCheckRenderer(ctx.outputMode);
      renderer.render(result);

      const isDenied = decisions.length === 0 ||
        decisions[0].effect === "deny";
      if (isDenied) Deno.exitCode = 1;
    } finally {
      await loader.dispose();
    }
  });
