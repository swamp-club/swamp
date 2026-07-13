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
  consumeStream,
  createLibSwampContext,
  createVaultAuditTrailDeps,
  vaultAuditTrail,
} from "../../libswamp/mod.ts";
import { createVaultAuditTrailRenderer } from "../../presentation/renderers/vault_audit_trail.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultAuditTrailCommand = new Command()
  .name("audit-trail")
  .description("View the secret-read audit trail for vaults.")
  .example(
    "Show recent reads",
    "swamp vault audit-trail",
  )
  .example(
    "Filter by vault",
    "swamp vault audit-trail --vault my-vault",
  )
  .example(
    "Filter by key and time range",
    "swamp vault audit-trail --vault my-vault --key API_KEY --since 2026-07-01",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--vault <name:string>", "Filter by vault name")
  .option("--key <key:string>", "Filter by secret key")
  .option(
    "--since <date:string>",
    "Start date, e.g. 2026-07-01 or 2026-07-01T00:00:00Z [default: 7 days ago]",
  )
  .option(
    "--until <date:string>",
    "End date, e.g. 2026-07-01 or 2026-07-01T00:00:00Z [default: now]",
  )
  .option(
    "--limit <count:integer>",
    "Maximum number of entries to return [default: 100]",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "audit-trail",
    ]);

    const { repoDir } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const since = options.since ? parseDate(options.since) : undefined;
    const until = options.until ? parseDate(options.until) : undefined;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultAuditTrailDeps(repoDir);
    const renderer = createVaultAuditTrailRenderer(cliCtx.outputMode);

    await consumeStream(
      vaultAuditTrail(ctx, deps, {
        vaultName: options.vault,
        secretKey: options.key,
        since,
        until,
        limit: options.limit,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault audit-trail command completed");
  });

function parseDate(value: string): Date {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new UserError(
      `Invalid date: '${value}'. Use ISO-8601 format (e.g. 2026-07-01 or 2026-07-01T00:00:00Z).`,
    );
  }
  return date;
}
