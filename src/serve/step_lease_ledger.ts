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

/**
 * Serve's store of step leases (see design/enablers/remote-execution.md).
 *
 * A lease transition reads one lease record, applies the lease lifecycle
 * from step_lease_model.ts and writes the next version, through the same
 * resource reader and writer a `swamp/step-lease` method run uses. It does
 * not run the method itself: a method run resolves, evaluates and records a
 * whole run around a body that only reads and writes that one record, and
 * a finished step waits on its `complete` (swamp-club#4038).
 */

import {
  createResourceReader,
  createResourceWriter,
} from "../domain/models/data_writer.ts";
import {
  type AcquireLeaseArgs,
  endedLease,
  type EndedLeaseState,
  leaseDataName,
  parseStoredLease,
  recordLeaseWrites,
  startLease,
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
  type StepLease,
  stepLeaseModel,
} from "../domain/models/worker/step_lease_model.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";

/** The step-lease transitions dispatch records. */
export interface StepLeaseStore {
  acquire(args: AcquireLeaseArgs): Promise<void>;
  markWrites(leaseId: string): Promise<void>;
  end(
    leaseId: string,
    state: EndedLeaseState,
    error?: string,
  ): Promise<void>;
}

/** The step-lease method that ends a lease in each state. */
export const LEASE_END_METHODS: Readonly<Record<EndedLeaseState, string>> = {
  completed: "complete",
  failed: "fail",
  expired: "expire",
};

/** Lease transitions as `swamp/step-lease` method runs on the `leases` instance. */
export function methodRunnerLeaseStore(
  runModelMethod: ModelMethodRunner,
): StepLeaseStore {
  const run = (methodName: string, inputs: Record<string, unknown>) =>
    runModelMethod({
      typeArg: STEP_LEASE_MODEL_TYPE.normalized,
      definitionName: STEP_LEASE_INSTANCE_NAME,
      methodName,
      inputs,
    });
  return {
    acquire: (args) => run("acquire", args),
    markWrites: (leaseId) => run("mark_writes", { leaseId }),
    end: (leaseId, state, error) =>
      run(LEASE_END_METHODS[state], {
        leaseId,
        ...(error !== undefined ? { error } : {}),
      }),
  };
}

/**
 * Writes lease records directly. Until the `leases` definition exists a
 * transition runs through `fallback`, the method run, which creates it the
 * way any direct type execution does.
 */
export class StepLeaseLedger implements StepLeaseStore {
  readonly #repoContext: Pick<
    RepositoryContext,
    "definitionRepo" | "unifiedDataRepo" | "markDirty" | "commitLog"
  >;
  readonly #fallback: StepLeaseStore;

  constructor(
    repoContext: Pick<
      RepositoryContext,
      "definitionRepo" | "unifiedDataRepo" | "markDirty" | "commitLog"
    >,
    fallback: StepLeaseStore,
  ) {
    this.#repoContext = repoContext;
    this.#fallback = fallback;
  }

  acquire(args: AcquireLeaseArgs): Promise<void> {
    return this.#transition(
      "acquire",
      args.leaseId,
      (stored) => startLease(args, stored, new Date()),
      () => this.#fallback.acquire(args),
    );
  }

  markWrites(leaseId: string): Promise<void> {
    return this.#transition(
      "mark_writes",
      leaseId,
      (stored) => recordLeaseWrites(leaseId, parseStoredLease(leaseId, stored)),
      () => this.#fallback.markWrites(leaseId),
    );
  }

  end(leaseId: string, state: EndedLeaseState, error?: string): Promise<void> {
    return this.#transition(
      LEASE_END_METHODS[state],
      leaseId,
      (stored) =>
        endedLease(
          leaseId,
          parseStoredLease(leaseId, stored),
          state,
          error,
          new Date(),
        ),
      () => this.#fallback.end(leaseId, state, error),
    );
  }

  /**
   * Reads the lease, and writes what `next` makes of it unless that is
   * null. The caller orders transitions of one lease; the datastore has no
   * compare-and-swap.
   */
  #transition(
    methodName: string,
    leaseId: string,
    next: (stored: Record<string, unknown> | null) => StepLease | null,
    fallback: () => Promise<void>,
  ): Promise<void> {
    return withSpan(
      "swamp.serve.step_lease.write",
      { "swamp.step_lease.method": methodName },
      async () => {
        const definition = await this.#repoContext.definitionRepo.findByName(
          STEP_LEASE_MODEL_TYPE,
          STEP_LEASE_INSTANCE_NAME,
        );
        if (definition === null) {
          await fallback();
          return;
        }
        const repo = this.#repoContext.unifiedDataRepo;
        const resources = stepLeaseModel.resources!;
        const name = leaseDataName(leaseId);
        // A root with no push, as the data plane's writes during a dispatch
        // run in: on the legacy datastore the writes stage into the
        // dispatching run's root, whose push carries them.
        await runInRootUnitOfWork(
          this.#repoContext,
          { flush: undefined },
          async () => {
            const read = createResourceReader(
              repo,
              STEP_LEASE_MODEL_TYPE,
              definition.id,
              undefined,
              undefined,
              resources,
            );
            const lease = next(await read(name));
            if (lease === null) return;
            const { writeResource } = createResourceWriter(
              repo,
              STEP_LEASE_MODEL_TYPE,
              definition.id,
              resources,
              undefined,
              undefined,
              definition.tags,
              undefined,
              definition.name,
            );
            await writeResource("lease", name, lease);
          },
        );
      },
    );
  }
}
