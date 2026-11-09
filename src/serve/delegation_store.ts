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

import type { DelegationDirectory } from "../domain/access/delegation_directory.ts";
import {
  DELEGATION_DATA_NAME,
  DELEGATION_MODEL_TYPE,
  delegationDefinitionName,
  delegationModel,
  type DelegationRecord,
  DelegationSchema,
} from "../domain/models/access/delegation_model.ts";
import { Definition } from "../domain/definitions/definition.ts";
import { createResourceWriter } from "../domain/models/data_writer.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";

const logger = getSwampLogger(["serve", "delegation-store"]);

export interface DelegationRecordLock {
  readonly synced: boolean;
  push(): Promise<void>;
  release(): Promise<void>;
}

export interface DelegationStoreDeps {
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  /** the record's model lock, pulling it fresh on a v2 custom datastore */
  readonly lock: (modelType: string, modelId: string) => Promise<
    DelegationRecordLock
  >;
  readonly confirmReplicated?: () => Promise<void>;
  readonly directory: Pick<DelegationDirectory, "reload">;
}

/** the write was not published, and the record was put back as it was */
export class DelegationWriteFailed extends Error {
  constructor(cause: unknown) {
    super(
      `The delegation change could not be saved: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "DelegationWriteFailed";
  }
}

export type TransitionResult<T> =
  | { readonly write: DelegationRecord; readonly value: T }
  | { readonly write: null; readonly value: T };

/**
 * every change to one delegation runs under its record's lock, reading the
 * record fresh after the lock's pull; a change is returned only once it is
 * published (and replicated on v3), so a caller never hands out a token no
 * other node will honour
 */
export class DelegationStore {
  readonly #deps: DelegationStoreDeps;
  readonly #inProcess = new Map<string, Promise<unknown>>();

  constructor(deps: DelegationStoreDeps) {
    this.#deps = deps;
  }

  /** what the record holds now, read without a lock; null when there is none */
  async read(id: string): Promise<DelegationRecord | null> {
    const content = await this.#deps.repoContext.unifiedDataRepo.getContent(
      DELEGATION_MODEL_TYPE,
      id,
      DELEGATION_DATA_NAME,
    );
    if (content === null) return null;
    return DelegationSchema.parse(
      JSON.parse(new TextDecoder().decode(content)),
    );
  }

  async create(record: DelegationRecord): Promise<void> {
    await this.transition(record.id, (current) => {
      if (current !== null) {
        throw new Error(`Delegation ${record.id} already exists`);
      }
      return Promise.resolve({ write: record, value: undefined });
    });
  }

  transition<T>(
    id: string,
    change: (current: DelegationRecord | null) => Promise<TransitionResult<T>>,
  ): Promise<T> {
    const previous = this.#inProcess.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#locked(id, change));
    this.#inProcess.set(id, next);
    const cleanup = () => {
      if (this.#inProcess.get(id) === next) this.#inProcess.delete(id);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async #locked<T>(
    id: string,
    change: (current: DelegationRecord | null) => Promise<TransitionResult<T>>,
  ): Promise<T> {
    const deps = this.#deps;
    const locks = await deps.lock(DELEGATION_MODEL_TYPE.normalized, id);
    if (locks.synced) deps.repoContext.catalogStore.invalidate();
    const current = await this.read(id);
    const result = await change(current).catch(async (error) => {
      await locks.release();
      throw error;
    });
    if (result.write === null) {
      await locks.release();
      return result.value;
    }
    const written = result.write;
    try {
      await this.#inRoot(locks, () => this.#write(written));
      await deps.confirmReplicated?.();
    } catch (error) {
      await this.#rollBack(id, current, error);
      throw new DelegationWriteFailed(error);
    } finally {
      await deps.directory.reload();
    }
    return result.value;
  }

  /**
   * a first write has nothing to restore; any other write is put back so a
   * later push can never publish tokens no caller received
   */
  async #rollBack(
    id: string,
    previous: DelegationRecord | null,
    cause: unknown,
  ): Promise<void> {
    logger.warn("Delegation {id} write failed, restoring it: {error}", {
      id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    if (previous === null) return;
    // one attempt that never rolls back itself, so a failing restore can't
    // restore the record it was undoing
    try {
      const deps = this.#deps;
      const locks = await deps.lock(DELEGATION_MODEL_TYPE.normalized, id);
      try {
        await this.#inRoot(
          locks,
          () =>
            this.#write({ ...previous, updatedAt: new Date().toISOString() }),
        );
      } finally {
        await deps.directory.reload();
      }
    } catch (error) {
      logger.error(
        "Delegation {id} could not be restored after a failed write; its tokens were never handed out: {error}",
        { id, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /** the push runs only once fn resolved, and its error is held past the release */
  async #inRoot(
    lock: DelegationRecordLock,
    fn: () => Promise<void>,
  ): Promise<void> {
    let pushError: { error: unknown } | undefined;
    try {
      await runInRootUnitOfWork(this.#deps.repoContext, {
        flush: async ({ completed }) => {
          if (!completed) return;
          try {
            await lock.push();
          } catch (error) {
            pushError = { error };
          }
        },
        pushWhen: "completed",
      }, fn);
    } finally {
      await lock.release();
    }
    if (pushError !== undefined) throw pushError.error;
  }

  async #write(record: DelegationRecord): Promise<void> {
    const { repoContext, repoDir } = this.#deps;
    const name = delegationDefinitionName(record.id);
    const existing = await repoContext.definitionRepo.findByName(
      DELEGATION_MODEL_TYPE,
      name,
    );
    if (!existing) {
      const created = Definition.create({
        id: record.id,
        type: DELEGATION_MODEL_TYPE.normalized,
        name,
        typeVersion: delegationModel.version,
      });
      const autoDefRepo = new YamlDefinitionRepository(
        repoDir,
        repoContext.eventBus,
        repoContext.autoDefinitionsDir,
        false,
        repoContext.markDirty,
      );
      await autoDefRepo.save(DELEGATION_MODEL_TYPE, created);
    }
    const { writeResource } = createResourceWriter(
      repoContext.unifiedDataRepo,
      DELEGATION_MODEL_TYPE,
      record.id,
      delegationModel.resources!,
      undefined,
      undefined,
      undefined,
      undefined,
      name,
    );
    await writeResource(
      "delegation",
      DELEGATION_DATA_NAME,
      record as unknown as Record<string, unknown>,
    );
  }
}
