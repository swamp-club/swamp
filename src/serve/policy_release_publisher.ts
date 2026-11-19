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

import type { PolicyRelease } from "../domain/access/policy_release.ts";
import {
  POLICY_RELEASE_DATA_NAME,
  POLICY_RELEASE_DEFINITION_NAME,
  POLICY_RELEASE_ID,
  POLICY_RELEASE_MODEL_TYPE,
  policyReleaseModel,
} from "../domain/models/access/policy_release_model.ts";
import { Definition } from "../domain/definitions/definition.ts";
import { createResourceWriter } from "../domain/models/data_writer.ts";
import { createModelUpdated } from "../domain/events/types.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";

const logger = getSwampLogger(["serve", "policy-release"]);

const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;

export interface PolicyReleasePublisherDeps {
  /** the writer lease's fence while this process holds it, else undefined */
  fence(): number | undefined;
  write(release: PolicyRelease): Promise<void>;
  retryDelayMs?(attempt: number): number;
}

/**
 * writes the newest policy a leader enforces for its followers. It runs in the
 * context it was constructed in, never a caller's unit of work or sync gate,
 * and an offer never waits on it, so no build or reply stalls behind a write.
 */
export class PolicyReleasePublisher {
  readonly #deps: PolicyReleasePublisherDeps;
  #latest: PolicyRelease | undefined;
  /** fence and digest of the last release that landed */
  #written: string | undefined;
  #wake: (() => void) | undefined;
  #idle: (() => void)[] = [];
  #busy = false;
  #stopped = false;
  readonly #stop = new AbortController();
  readonly #loop: Promise<void>;

  constructor(deps: PolicyReleasePublisherDeps) {
    this.#deps = deps;
    this.#loop = this.#run();
  }

  offer(release: PolicyRelease): void {
    if (this.#stopped) return;
    this.#latest = release;
    this.#wake?.();
  }

  /** resolves once every offer so far has been written or given up */
  settled(): Promise<void> {
    if (!this.#busy && this.#latest === undefined) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stop.abort();
    this.#wake?.();
    await this.#loop;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      if (this.#latest === undefined) {
        for (const resolve of this.#idle.splice(0)) resolve();
        await new Promise<void>((resolve) => this.#wake = resolve);
        this.#wake = undefined;
        continue;
      }
      this.#busy = true;
      const release = this.#latest;
      this.#latest = undefined;
      try {
        await this.#publish(release);
      } finally {
        this.#busy = false;
      }
    }
    for (const resolve of this.#idle.splice(0)) resolve();
  }

  async #publish(release: PolicyRelease): Promise<void> {
    for (let attempt = 0;; attempt++) {
      const fence = this.#deps.fence();
      // not leading: the next leader publishes what it enforces
      if (fence === undefined || this.#stopped) return;
      const key = `${fence}:${release.digest()}`;
      // a new fence publishes even an unchanged policy: followers accept
      // only the current leader's release
      if (key === this.#written) return;
      try {
        await this.#deps.write(release);
        this.#written = key;
        return;
      } catch (error) {
        logger
          .warn`Publishing the policy to followers failed, retrying: ${error}`;
      }
      // a newer offer replaces this one
      if (this.#latest !== undefined) return;
      const delay = this.#deps.retryDelayMs?.(attempt) ??
        Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.#stop.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}

export interface PolicyReleaseLock {
  readonly synced: boolean;
  push(): Promise<void>;
  release(): Promise<void>;
}

export interface PolicyReleaseWriterDeps {
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly lock: (modelType: string, modelId: string) => Promise<
    PolicyReleaseLock
  >;
  readonly confirmReplicated?: () => Promise<void>;
}

/** writes release-main under its own lock and root unit of work, as a delegation record is */
export function createPolicyReleaseWriter(
  deps: PolicyReleaseWriterDeps,
): (release: PolicyRelease) => Promise<void> {
  return async (release) => {
    const { repoContext, repoDir } = deps;
    const lock = await deps.lock(
      POLICY_RELEASE_MODEL_TYPE.normalized,
      POLICY_RELEASE_ID,
    );
    let pushError: { error: unknown } | undefined;
    try {
      if (lock.synced) repoContext.catalogStore.invalidate();
      await runInRootUnitOfWork(repoContext, {
        flush: async ({ completed }) => {
          if (!completed) return;
          try {
            await lock.push();
          } catch (error) {
            pushError = { error };
          }
        },
        pushWhen: "completed",
      }, async () => {
        const existing = await repoContext.definitionRepo.findByName(
          POLICY_RELEASE_MODEL_TYPE,
          POLICY_RELEASE_DEFINITION_NAME,
        );
        if (!existing) {
          await new YamlDefinitionRepository(
            repoDir,
            repoContext.eventBus,
            repoContext.autoDefinitionsDir,
            false,
            repoContext.markDirty,
          ).save(
            POLICY_RELEASE_MODEL_TYPE,
            Definition.create({
              id: POLICY_RELEASE_ID,
              type: POLICY_RELEASE_MODEL_TYPE.normalized,
              name: POLICY_RELEASE_DEFINITION_NAME,
              typeVersion: policyReleaseModel.version,
            }),
          );
        }
        const { writeResource } = createResourceWriter(
          repoContext.unifiedDataRepo,
          POLICY_RELEASE_MODEL_TYPE,
          POLICY_RELEASE_ID,
          policyReleaseModel.resources!,
          undefined,
          undefined,
          undefined,
          undefined,
          POLICY_RELEASE_DEFINITION_NAME,
        );
        const written = await writeResource(
          "release",
          POLICY_RELEASE_DATA_NAME,
          release.toAttrs() as unknown as Record<string, unknown>,
        );
        await repoContext.eventBus.publish(
          createModelUpdated(
            POLICY_RELEASE_MODEL_TYPE.normalized,
            POLICY_RELEASE_ID,
            POLICY_RELEASE_DEFINITION_NAME,
            [{ name: written.name, version: written.version }],
          ),
        );
      });
    } finally {
      await lock.release();
    }
    if (pushError !== undefined) throw pushError.error;
    await deps.confirmReplicated?.();
  };
}
