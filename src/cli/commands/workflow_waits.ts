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
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createWorkflowWaitsDeps,
  type PendingSignalInfo,
  workflowWaits,
  type WorkflowWaitsData,
  type WorkflowWaitsDeps,
  type WorkflowWaitsEvent,
  type WorkflowWaitsOptions,
} from "../../libswamp/workflows/waits.ts";
import type { LibSwampContext } from "../../libswamp/context.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepoUnlocked,
  signalWaitsOf,
} from "../repo_context.ts";
import {
  formatCommandTarget,
  requestNewerServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  WorkflowWaitsPayload,
  WorkflowWaitsResponse,
} from "../../serve/protocol.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** How {@link renderWaits} prints a listing. */
export interface RenderWaitsOptions {
  /**
   * `--pending` was given. A listing without `pending` then came from a
   * server that predates pending-signal listing, which log mode warns of.
   */
  pendingAsked?: boolean;
}

/**
 * Renders the open waits in log or JSON mode. Commands go through
 * writeOutput, not the logger, so they can be copied as printed. `--quiet`
 * hides them, as it hides the logger's info lines. `commandTarget` is
 * appended to every command in both modes, so it reaches the same repository
 * from another directory. JSON carries `pending` only when the listing does,
 * which it does only when `--pending` was given.
 */
export function renderWaits(
  cliCtx: CommandContext,
  result: WorkflowWaitsData,
  commandTarget = "",
  options: RenderWaitsOptions = {},
): void {
  const waits = result.waits.map((wait) => ({
    ...wait,
    nextCommand: `${wait.nextCommand}${commandTarget}`,
    ...(wait.signalByKeyCommand !== undefined
      ? { signalByKeyCommand: `${wait.signalByKeyCommand}${commandTarget}` }
      : {}),
  }));
  const unreadableWaits = result.unreadableWaits.map((wait) => ({
    ...wait,
    nextCommand: `${wait.nextCommand}${commandTarget}`,
  }));
  const pending = result.pending;
  if (cliCtx.outputMode === "json") {
    console.log(
      JSON.stringify(
        {
          waits,
          unreadableWaits,
          ...(pending !== undefined ? { pending } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  const quiet = cliCtx.verbosity === "quiet";
  if (waits.length === 0 && unreadableWaits.length === 0) {
    cliCtx.logger.info("No workflows waiting for a signal");
  }
  for (const wait of waits) {
    cliCtx.logger.info(
      "{workflowName} / {stepName} — wait {waitId}",
      {
        workflowName: wait.workflowName,
        stepName: wait.stepName,
        waitId: wait.waitId,
      },
    );
    cliCtx.logger.info("  Run:      {runId}", { runId: wait.runId });
    if (wait.key !== undefined) {
      cliCtx.logger.info("  Key:      {key}", { key: wait.key });
    }
    cliCtx.logger.info(
      wait.expired
        ? "  Deadline: {deadline} (expired — a resume fails the step)"
        : "  Deadline: {deadline}",
      { deadline: wait.deadline },
    );
    cliCtx.logger.info("  Schema:   {schema}", {
      schema: JSON.stringify(wait.schema),
    });
    if (!quiet) {
      writeOutput(`  ${wait.nextCommand}`);
      if (wait.signalByKeyCommand !== undefined) {
        // An alternative to the line above, labelled so it is not read as
        // a second step; a shell comment keeps both lines pasteable.
        writeOutput("  # or by key:");
        writeOutput(`  ${wait.signalByKeyCommand}`);
      }
    }
  }
  for (const wait of unreadableWaits) {
    cliCtx.logger.warn(
      "{workflowName} / {stepName} — the wait stored on run {runId} cannot be read, so no signal can reach it. A resume fails the step with wait_unreadable.",
      {
        workflowName: wait.workflowName,
        stepName: wait.stepName,
        runId: wait.runId,
      },
    );
    if (!quiet) writeOutput(`  ${wait.nextCommand}`);
  }
  if (pending !== undefined) {
    renderPending(cliCtx, pending);
  } else if (options.pendingAsked) {
    cliCtx.logger.warn(
      "The server did not list pending signals; it may predate --pending. Upgrade swamp on the server to list them.",
    );
  }
}

/** The log-mode section listing held pending signals, by receipt. */
function renderPending(
  cliCtx: CommandContext,
  pending: PendingSignalInfo[],
): void {
  if (pending.length === 0) {
    cliCtx.logger.info("No pending signals");
    return;
  }
  cliCtx.logger.info("Pending signals (held for the next wait of their key)");
  for (const signal of pending) {
    cliCtx.logger.info(
      "{workflowName} — pending signal {receiptId}",
      { workflowName: signal.workflowName, receiptId: signal.receiptId },
    );
    cliCtx.logger.info("  Key:        {key}", { key: signal.key });
    cliCtx.logger.info("  Received:   {receivedAt}", {
      receivedAt: signal.receivedAt,
    });
    cliCtx.logger.info("  Held until: {heldUntil}", {
      heldUntil: signal.heldUntil,
    });
    cliCtx.logger.info("  Sender:     {submittedBy}", {
      submittedBy: signal.submittedBy,
    });
  }
}

/**
 * The dependencies of a local listing. The workflow repository names a
 * pending signal sent through the local CLI, which carries only its
 * workflow's ID: without it such a signal is never listed.
 */
export function localWaitsDeps(
  repoContext: Pick<
    RepositoryContext,
    "workflowRunRepo" | "signalWaits" | "workflowRepo"
  >,
): WorkflowWaitsDeps {
  return createWorkflowWaitsDeps(
    repoContext.workflowRunRepo,
    signalWaitsOf(repoContext),
    repoContext.workflowRepo,
  );
}

/** Lists the waits of this repository. */
export async function listLocalWaits(
  ctx: LibSwampContext,
  deps: WorkflowWaitsDeps,
  options: WorkflowWaitsOptions = {},
): Promise<WorkflowWaitsData> {
  let data: WorkflowWaitsData = { waits: [], unreadableWaits: [] };
  await consumeStream<WorkflowWaitsEvent>(
    workflowWaits(ctx, deps, options),
    {
      resolving: () => {},
      completed: (e) => {
        data = e.data;
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    },
  );
  return data;
}

/** Sends one `workflow.waits` request to a server and returns its reply. */
export type WaitsRequester = (request: {
  type: "workflow.waits";
  payload?: WorkflowWaitsPayload;
}) => Promise<WorkflowWaitsResponse>;

/**
 * Lists the waits a server holds. `pending` is asked for only with
 * `includePending`, and passed on only then: a reply without it came from a
 * server that predates pending-signal listing, and so lacks it.
 */
export async function listServerWaits(
  request: WaitsRequester,
  options: { includePending?: boolean } = {},
): Promise<WorkflowWaitsData> {
  const response = await request({
    type: "workflow.waits",
    ...(options.includePending ? { payload: { includePending: true } } : {}),
  });
  const listed = response.data as Partial<WorkflowWaitsData>;
  return {
    waits: listed.waits ?? [],
    unreadableWaits: listed.unreadableWaits ?? [],
    ...(options.includePending && listed.pending !== undefined
      ? { pending: listed.pending }
      : {}),
  };
}

export const workflowWaitsCommand = withRemoteOptions(
  new Command()
    .name("waits")
    .description("List all workflow steps waiting for a signal")
    .example("List open waits", "swamp workflow waits")
    .example(
      "List the open waits a server holds",
      "swamp workflow waits --server wss://swamp.example.com",
    )
    .example(
      "Also list signals held for a wait that has not opened yet",
      "swamp workflow waits --pending",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--pending",
      "Also list signals sent by key that are held for the next wait of their key",
    ),
)
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "waits",
    ]);
    const includePending = options.pending === true;

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(server, options);
      const data = await listServerWaits(
        (request) =>
          requestNewerServerResponse<WorkflowWaitsResponse>(
            "listing signal waits",
            { server, token },
            request,
          ),
        { includePending },
      );
      renderWaits(
        cliCtx,
        data,
        formatCommandTarget({ server: options.server as string | undefined }),
        { pendingAsked: includePending },
      );
      return;
    }

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const data = await listLocalWaits(ctx, localWaitsDeps(repoContext), {
      includePending,
    });

    renderWaits(
      cliCtx,
      data,
      formatCommandTarget({ repoDir: options.repoDir as string | undefined }),
      { pendingAsked: includePending },
    );
  });
