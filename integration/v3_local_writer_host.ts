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

import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  createModelLock,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { ProcessHost } from "./process_host.ts";

export type LocalWriterRequest =
  | { readonly kind: "open"; readonly repoDir: string; readonly type: string }
  | {
    readonly kind: "write";
    readonly id: string;
    readonly model: string;
    readonly data: string;
    /** staged, then held open until resumed, as a slow step holds its unit */
    readonly pause?: boolean;
    /** under the behavior's own lock, as a method run takes it */
    readonly lock?: boolean;
    /** padding past the inline limit, so the content is stored as chunks */
    readonly pad?: string;
  }
  | {
    readonly kind: "read";
    readonly id: string;
    /** by id: a definition lives in its own checkout, the data in the datastore */
    readonly modelId: string;
    readonly data: string;
  }
  | { readonly kind: "resume"; readonly id: string }
  | { readonly kind: "close" };

export type LocalWriterMessage =
  | { readonly opened: true }
  | { readonly paused: string }
  | {
    readonly written: string;
    readonly version: number;
    /** the count this write stored: one more than the latest it read */
    readonly count: number;
    readonly modelId: string;
  }
  | { readonly read: string; readonly content: string | null }
  | { readonly closed: true }
  | { readonly failed: string; readonly id?: string };

/** one swamp process writing a checkout of a local filesystem v3 datastore */
export const localWriterHost: ProcessHost<
  LocalWriterRequest,
  LocalWriterMessage
> = (post) => {
  let context: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;
  let type: ModelType;
  const resumes = new Map<string, () => void>();
  const definitions = new Map<string, Definition>();

  async function definitionOf(name: string): Promise<Definition> {
    const known = definitions.get(name);
    if (known !== undefined) return known;
    const found = await context.repoContext.definitionRepo.findByName(
      type,
      name,
    );
    if (found !== null) {
      definitions.set(name, found);
      return found;
    }
    const created = Definition.create({ name, globalArguments: {} });
    await runInRootUnitOfWork(
      context.repoContext,
      { flush: undefined },
      () => context.repoContext.definitionRepo.save(type, created),
    );
    definitions.set(name, created);
    return created;
  }

  async function write(
    request: Extract<LocalWriterRequest, { kind: "write" }>,
  ): Promise<{ version: number; count: number; modelId: string }> {
    let version = 0;
    let count = 0;
    let modelId = "";
    const body = async () => {
      await runInRootUnitOfWork(
        context.repoContext,
        { flush: undefined },
        async () => {
          const model = await definitionOf(request.model);
          modelId = model.id;
          const latest = await context.repoContext.unifiedDataRepo.getContent(
            type,
            model.id,
            request.data,
          );
          count = latest === null
            ? 1
            : (JSON.parse(new TextDecoder().decode(latest)).count as number) +
              1;
          const data = Data.create({
            name: request.data,
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 1000,
            tags: { type: "resource", modelName: model.name },
            ownerDefinition: {
              ownerType: "model-method",
              ownerRef: `${type.normalized}:${model.id}`,
            },
          });
          const saved = await context.repoContext.unifiedDataRepo.save(
            type,
            model.id,
            data,
            new TextEncoder().encode(
              JSON.stringify({
                by: request.id,
                count,
                ...(request.pad === undefined ? {} : { pad: request.pad }),
              }),
            ),
          );
          version = saved.version;
          if (request.pause === true) {
            const resumed = new Promise<void>((resolve) =>
              resumes.set(request.id, resolve)
            );
            post({ paused: request.id });
            await resumed;
          }
        },
      );
    };
    if (request.lock !== true) {
      await body();
      return { version, count, modelId };
    }
    const model = await definitionOf(request.model);
    const lock = await createModelLock(
      context.datastoreConfig,
      type.normalized,
      model.id,
    );
    await lock.acquire();
    try {
      await body();
    } finally {
      await lock.release();
    }
    return { version, count, modelId };
  }

  async function read(
    request: Extract<LocalWriterRequest, { kind: "read" }>,
  ): Promise<string | null> {
    const content = await context.repoContext.unifiedDataRepo.getContent(
      type,
      request.modelId,
      request.data,
    );
    return content === null ? null : new TextDecoder().decode(content);
  }

  return (request) => {
    switch (request.kind) {
      case "open":
        type = ModelType.create(request.type);
        requireInitializedRepoUnlocked({
          repoDir: request.repoDir,
          outputMode: "json",
        }).then(
          (opened) => {
            context = opened;
            post({ opened: true });
          },
          (error) => post({ failed: String(error) }),
        );
        return;
      case "write":
        write(request).then(
          ({ version, count, modelId }) =>
            post({ written: request.id, version, count, modelId }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "read":
        read(request).then(
          (content) => post({ read: request.id, content }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "resume":
        resumes.get(request.id)?.();
        resumes.delete(request.id);
        return;
      case "close":
        closeV3Datastores().then(
          () => post({ closed: true }),
          (error) => post({ failed: String(error) }),
        );
        return;
    }
  };
};
