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
 * The datastore API test server (swamp-club#3915, swamp-club#3922): an
 * in-process client against a port-0 server over a real v3 repository, as
 * serve wires it, with commit and content helpers that write what a real
 * client's repositories write.
 */

import { assert } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { handleDatastoreRequest } from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import {
  asTryLock,
  DatastoreLockLeases,
} from "../src/serve/datastore_locks.ts";
import {
  createModelLock,
  createWorkflowRunLock,
} from "../src/cli/repo_context.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { encodeCommitBody } from "../src/infrastructure/datastore_v3/chunk_ingest.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import type {
  V3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { createServeCtx, grant } from "./serve_request_harness.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

/** Bearer tokens the test server accepts, and whom they authenticate. */
export const TOKENS: Record<string, string> = {
  "alice-token": "user:caller",
  "bob-token": "user:bob",
};

export interface Server {
  readonly url: string;
  readonly v3: V3Datastore;
  readonly ctx: ConnectionContext;
  readonly modelType: ModelType;
  readonly model: Definition;
  /** The locks serve holds for callers, as serve wires them. */
  readonly locks: DatastoreLockLeases;
  /** Answers a request in-process, as the server does. */
  readonly handle: (req: Request) => Promise<Response>;
  policyLoads: number;
  close(): Promise<void>;
}

/**
 * Starts a port-0 server over a fresh v3 repository that holds one
 * behavior, `web`, and enforces `grants`.
 */
export async function withServer(
  grants: Grant[],
  fn: (server: Server) => Promise<void>,
  ledger = new UploadLedger(),
  options: { managedConfig?: boolean } = {},
): Promise<void> {
  resetRateLimitState();
  await withV3RowRepos(options, async (repos) => {
    const repo = repos.serveRepo;
    const model = Definition.create({ name: "web", globalArguments: {} });
    await runInRootUnitOfWork(
      repo.repoContext,
      { flush: undefined },
      () => repo.repoContext.definitionRepo.save(repo.modelType, model),
    );
    const location = await v3DatastoreConfigOf(
      repo.repoDir,
      repo.datastoreConfig,
    );
    assert(location !== undefined, "the fixture repository is v3");
    const v3 = v3DatastoreFor(repo.repoDir, location);
    const base = createServeCtx(repo, grants);
    const locks = new DatastoreLockLeases({
      createLock: async (target) =>
        asTryLock(
          target.kind === "model"
            ? await createModelLock(
              base.datastoreConfig,
              target.modelType,
              target.modelId,
            )
            : await createWorkflowRunLock(base.datastoreConfig, target.runId),
        ),
    });
    const server: Server = {
      url: "",
      v3,
      ctx: base,
      modelType: repo.modelType,
      model,
      locks,
      handle: () => Promise.reject(new Error("not started")),
      policyLoads: 0,
      close: () => Promise.resolve(),
    };
    const ctx = {
      ...base,
      policySnapshotLoader: Object.assign(
        Object.create(base.policySnapshotLoader ?? null),
        {
          decisionService: base.policySnapshotLoader?.decisionService,
          load: () => {
            server.policyLoads++;
            return Promise.resolve();
          },
        },
      ),
    } as ConnectionContext;
    const handle = async (req: Request): Promise<Response> => {
      const route = matchDatastoreRoute(new URL(req.url).pathname);
      if (route === undefined) return new Response("no", { status: 404 });
      return await handleDatastoreRequest(req, route, "127.0.0.1", {
        ctx,
        v3,
        ledger,
        locks,
        authenticate: (token) => {
          const principalId = TOKENS[token];
          return Promise.resolve(
            principalId === undefined
              ? { ok: false, error: "bad token", reason: "secret-mismatch" }
              : {
                ok: true,
                principalId,
                collectives: [],
                groups: [],
                tokenName: token,
                tokenCreatedAt: "2026-01-01T00:00:00Z",
              },
          );
        },
      });
    };
    const http = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      handle,
    );
    try {
      Object.assign(server, {
        url: `http://127.0.0.1:${http.addr.port}/api/v1/datastore/_default`,
        ctx,
        handle,
      });
      await fn(server);
    } finally {
      await http.shutdown();
      await locks.dispose();
    }
  });
}

export function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
}

/** The framed body of a commit request. */
export function commitBody(
  envelope: Record<string, unknown>,
  chunks: readonly Uint8Array[] = [],
): Uint8Array {
  return encodeCommitBody(envelope, chunks.map((bytes) => ({ bytes })));
}

export function partitionPath(server: Server, id = server.model.id): string {
  const partition = partitionOf({
    kind: "model",
    type: server.modelType,
    id,
  });
  return `${server.url}/partitions/${
    encodeURIComponent(partition.toString())
  }/commits`;
}

/** Data metadata as the data repository writes it. */
export function dataMetadata(
  name: string,
  version: number,
): Record<string, unknown> {
  return {
    name,
    id: crypto.randomUUID(),
    version,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

/** A behavior definition's file, as the definition repository writes it. */
export function definitionYaml(
  name: string,
  type: string,
  id: string = crypto.randomUUID(),
): Uint8Array {
  return new TextEncoder().encode(
    stringifyYaml(
      JSON.parse(JSON.stringify(
        Definition.create({ id, name, type, globalArguments: {} }).toData(),
      )),
    ),
  );
}

/** The ops of a data save of `bytes`, stored as a chunk. */
export async function blobSaveOps(
  server: Server,
  name: string,
  version: number,
  bytes: Uint8Array,
  modelId = server.model.id,
): Promise<unknown[]> {
  const type = server.modelType.normalized;
  const base = `data/${type}/${modelId}/${name}/${version}`;
  const intent = {
    kind: "data.save",
    model: { type, id: modelId },
    name,
    version,
  };
  const metadata = dataMetadata(name, version);
  return [
    {
      kind: "put",
      intent,
      key: `${base}/raw`,
      blob: { sha256: await sha256Hex(bytes), size: bytes.length },
    },
    {
      kind: "put",
      intent,
      key: `${base}/metadata.yaml`,
      inline: btoa(stringifyYaml(metadata)),
    },
    {
      kind: "data-version",
      key: `${base}/metadata.yaml`,
      metadata,
    },
  ];
}

export async function post(
  url: string,
  token: string,
  body: Uint8Array,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/vnd.swamp.commit+v1",
    },
    body: body as Uint8Array<ArrayBuffer>,
  });
  return { status: response.status, json: await response.json() };
}

export async function getJson(
  url: string,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, json: await response.json() };
}

/** A team member's grants: run, write and read, but not admin. */
export const member = (): Grant[] => [
  grant({
    actions: ["read", "write", "run"],
    resource: { kind: "model", pattern: "*" },
  }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

/**
 * An admin's grants, for commits whose content the tests do not make up as
 * a real client would (a control-plane record, a definition of any type).
 */
export const writer = (): Grant[] => [
  ...member(),
  grant({ actions: ["admin"], resource: { kind: "access", pattern: "*" } }),
];
