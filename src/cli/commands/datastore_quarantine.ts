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
import { resolveDatastoreForRepo, v3LocationOf } from "../repo_context.ts";
import { groupCommandAction } from "../group_action.ts";
import { serveUpstreamAt } from "../../infrastructure/datastore_v3/serve_upstream_registry.ts";
import { UserError } from "../../domain/errors.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { datastoreQuarantineAccept } from "../../libswamp/datastores/quarantine_accept.ts";
import { datastoreQuarantineDiscard } from "../../libswamp/datastores/quarantine_discard.ts";
import {
  createDatastoreQuarantineAcceptRenderer,
  createDatastoreQuarantineDiscardRenderer,
} from "../../presentation/renderers/datastore_quarantine.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Lands a change serve keeps because its author lacked a grant it needs
 * (swamp-club#4195). Admin only; asked of the serve this checkout writes
 * through.
 */
const datastoreQuarantineAcceptCommand = new Command()
  .description(
    "Accept a quarantined change: land it as its author (admin only)",
  )
  .arguments("<txn_id:string>")
  .example(
    "Accept a quarantined change",
    "swamp datastore quarantine accept 0f8c57cf-4f22-4233-bf81-ecc6b4492fb8",
  )
  .example(
    "List quarantined changes and their txnIds",
    "swamp datastore status",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, txnId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "quarantine",
      "accept",
    ]);
    const repoDir = resolveRepoDir(options.repoDir);
    const resolution = await resolveDatastoreForRepo(repoDir);
    if (resolution.serveUpstream === undefined) {
      throw new UserError(
        "This checkout does not write through swamp serve: only serve keeps quarantined changes.",
      );
    }
    const binding = serveUpstreamAt((await v3LocationOf(resolution)).path);
    if (binding === undefined) {
      throw new Error("Internal error: the serve upstream is not bound");
    }
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreQuarantineAcceptRenderer(
      cliCtx.outputMode,
    );
    await consumeStream(
      datastoreQuarantineAccept(ctx, {
        accept: async (id) => {
          const client = binding.client();
          try {
            // Bounded by the client's own per-request timeout.
            return await client.acceptQuarantine(
              id,
              new AbortController().signal,
            );
          } finally {
            client.close();
          }
        },
      }, { txnId }),
      renderer.handlers(),
    );
  });

/**
 * Discards a change serve keeps because its author lacked a grant it needs,
 * so it never lands (swamp-club#4195). Admin only; asked of the serve this
 * checkout writes through.
 */
const datastoreQuarantineDiscardCommand = new Command()
  .description(
    "Discard a quarantined change so it never lands (admin only)",
  )
  .arguments("<txn_id:string>")
  .example(
    "Discard a quarantined change",
    "swamp datastore quarantine discard 0f8c57cf-4f22-4233-bf81-ecc6b4492fb8",
  )
  .example(
    "List quarantined changes and their txnIds",
    "swamp datastore status",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, txnId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "quarantine",
      "discard",
    ]);
    const repoDir = resolveRepoDir(options.repoDir);
    const resolution = await resolveDatastoreForRepo(repoDir);
    if (resolution.serveUpstream === undefined) {
      throw new UserError(
        "This checkout does not write through swamp serve: only serve keeps quarantined changes.",
      );
    }
    const binding = serveUpstreamAt((await v3LocationOf(resolution)).path);
    if (binding === undefined) {
      throw new Error("Internal error: the serve upstream is not bound");
    }
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreQuarantineDiscardRenderer(
      cliCtx.outputMode,
    );
    await consumeStream(
      datastoreQuarantineDiscard(ctx, {
        discard: async (id) => {
          const client = binding.client();
          try {
            // Bounded by the client's own per-request timeout.
            return await client.discardQuarantine(
              id,
              new AbortController().signal,
            );
          } finally {
            client.close();
          }
        },
      }, { txnId }),
      renderer.handlers(),
    );
  });

/** `swamp datastore quarantine`: changes serve keeps for an admin. */
export const datastoreQuarantineCommand = new Command()
  .name("quarantine")
  .description("Changes serve keeps because their author lacks a grant")
  .action(groupCommandAction)
  .command("accept", datastoreQuarantineAcceptCommand)
  .command("discard", datastoreQuarantineDiscardCommand);
