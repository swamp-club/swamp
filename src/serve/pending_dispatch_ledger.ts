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

import {
  createResourceReader,
  createResourceWriter,
} from "../domain/models/data_writer.ts";
import {
  endedPendingDispatch,
  type EnqueuePendingArgs,
  parseStoredPendingDispatch,
  PENDING_DISPATCH_END_METHODS,
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
  pendingDataName,
  type PendingDispatch,
  type PendingDispatchEnd,
  pendingDispatchModel,
  startPendingDispatch,
} from "../domain/models/worker/pending_dispatch_model.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";

// serve never orphans through the store: boot reconciliation writes orphaned records itself
export type ServePendingDispatchEnd =
  | Extract<PendingDispatchEnd, { state: "dispatched" }>
  | { state: "timed_out" | "cancelled"; endedAt: string };

export interface PendingDispatchStore {
  enqueue(args: EnqueuePendingArgs): Promise<void>;
  end(queueId: string, end: ServePendingDispatchEnd): Promise<void>;
}

export function methodRunnerPendingDispatchStore(
  runModelMethod: ModelMethodRunner,
): PendingDispatchStore {
  const run = (methodName: string, inputs: Record<string, unknown>) =>
    runModelMethod({
      typeArg: PENDING_DISPATCH_MODEL_TYPE.normalized,
      definitionName: PENDING_DISPATCH_INSTANCE_NAME,
      methodName,
      inputs,
    });
  return {
    enqueue: (args) => run("enqueue", { ...args }),
    end: (queueId, end) => {
      const { state, ...fields } = end;
      return run(PENDING_DISPATCH_END_METHODS[state], { queueId, ...fields });
    },
  };
}

// bypasses the method run so a queue transition records no output, run log or evaluated definition
export class PendingDispatchLedger implements PendingDispatchStore {
  readonly #repoContext: Pick<
    RepositoryContext,
    "definitionRepo" | "unifiedDataRepo" | "markDirty" | "commitLog"
  >;
  readonly #fallback: PendingDispatchStore;
  // the fallback creating the definition; concurrent transitions in a fresh repo wait for it rather than each running the method
  #bootstrap: Promise<void> | null = null;

  constructor(
    repoContext: Pick<
      RepositoryContext,
      "definitionRepo" | "unifiedDataRepo" | "markDirty" | "commitLog"
    >,
    fallback: PendingDispatchStore,
  ) {
    this.#repoContext = repoContext;
    this.#fallback = fallback;
  }

  enqueue(args: EnqueuePendingArgs): Promise<void> {
    return this.#transition(
      "enqueue",
      args.queueId,
      (stored) => startPendingDispatch(args, stored),
      () => this.#fallback.enqueue(args),
    );
  }

  end(queueId: string, end: ServePendingDispatchEnd): Promise<void> {
    return this.#transition(
      PENDING_DISPATCH_END_METHODS[end.state],
      queueId,
      (stored) =>
        endedPendingDispatch(parseStoredPendingDispatch(queueId, stored), end),
      () => this.#fallback.end(queueId, end),
    );
  }

  // read-then-write with no compare-and-swap: the dispatch tail orders each queue entry's transitions
  #transition(
    methodName: string,
    queueId: string,
    next: (stored: Record<string, unknown> | null) => PendingDispatch | null,
    fallback: () => Promise<void>,
  ): Promise<void> {
    return withSpan(
      "swamp.serve.pending_dispatch.write",
      { "swamp.pending_dispatch.method": methodName },
      async () => {
        const find = () =>
          this.#repoContext.definitionRepo.findByName(
            PENDING_DISPATCH_MODEL_TYPE,
            PENDING_DISPATCH_INSTANCE_NAME,
          );
        let definition = await find();
        // a failed bootstrap leaves the definition missing, so the next waiter takes over
        while (definition === null && this.#bootstrap !== null) {
          await this.#bootstrap.catch(() => {});
          definition = await find();
        }
        // the method run resolves a definition that does not exist yet
        if (definition === null) {
          const bootstrap = fallback();
          this.#bootstrap = bootstrap;
          try {
            await bootstrap;
          } finally {
            if (this.#bootstrap === bootstrap) this.#bootstrap = null;
          }
          return;
        }
        const repo = this.#repoContext.unifiedDataRepo;
        const resources = pendingDispatchModel.resources!;
        const name = pendingDataName(queueId);
        // no push of its own, matching the method run's unit: a dispatching
        // run's root carries the write, and outside one it goes to the hook
        await runInRootUnitOfWork(
          this.#repoContext,
          { flush: undefined },
          async () => {
            const read = createResourceReader(
              repo,
              PENDING_DISPATCH_MODEL_TYPE,
              definition.id,
              undefined,
              undefined,
              resources,
            );
            const record = next(await read(name));
            if (record === null) return;
            const { writeResource } = createResourceWriter(
              repo,
              PENDING_DISPATCH_MODEL_TYPE,
              definition.id,
              resources,
              undefined,
              undefined,
              definition.tags,
              undefined,
              definition.name,
            );
            await writeResource("dispatch", name, record);
          },
        );
      },
    );
  }
}
