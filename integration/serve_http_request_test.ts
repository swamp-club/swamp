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

import { assertEquals, assertRejects } from "@std/assert";
import { Data } from "../src/domain/data/data.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { handleHttpRequest } from "../src/serve/http_request_route.ts";
import { SERVE_REQUEST_PATH } from "../src/serve/protocol.ts";
import {
  requestServerResponse,
  ServerResponseError,
} from "../src/cli/remote_run.ts";
import {
  CALLER,
  createServeCtx,
  grant,
  saveModel,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

const OVER_FRAME_LIMIT_BYTES = 64 * 1024 * 1024 + 1024;

function startRoute(ctx: ConnectionContext): {
  url: string;
  shutdown: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname !== SERVE_REQUEST_PATH) {
        return new Response("Not found", { status: 404 });
      }
      return handleHttpRequest(req, "127.0.0.1", {
        ctx,
        authenticate: () =>
          Promise.resolve({
            ok: true,
            principalId: `${CALLER.kind}:${CALLER.id}`,
            collectives: [],
            groups: [],
            tokenName: "integration",
            tokenCreatedAt: "2026-11-01T00:00:00.000Z",
          }),
      });
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

async function saveLargeText(repo: ServeRepo): Promise<void> {
  const model = await saveModel(repo, "big-model");
  const data = Data.create({
    name: "big",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: model.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode("x".repeat(OVER_FRAME_LIMIT_BYTES)),
  );
}

const readEverything = [
  grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

Deno.test({
  name:
    "serve HTTP route: data.get with content over the 64 MiB frame limit reaches the CLI client whole",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveLargeText(repo);
      const server = startRoute(createServeCtx(repo, readEverything));
      try {
        const reply = await requestServerResponse<
          { data: { content: string; contentEncoding: string } }
        >(
          { server: server.url, token: "integration-token" },
          {
            type: "data.get",
            payload: { modelIdOrName: "big-model", dataName: "big" },
          },
        );
        assertEquals(reply.data.contentEncoding, "utf-8");
        assertEquals(reply.data.content.length, OVER_FRAME_LIMIT_BYTES);
      } finally {
        await server.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "serve HTTP route: the WebSocket's authorization applies to a read over HTTP",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveLargeText(repo);
      const server = startRoute(createServeCtx(repo, []));
      try {
        const error = await assertRejects(
          () =>
            requestServerResponse(
              { server: server.url, token: "integration-token" },
              {
                type: "data.get",
                payload: { modelIdOrName: "big-model", dataName: "big" },
              },
            ),
          ServerResponseError,
        );
        assertEquals(error.code, "unauthorized");
      } finally {
        await server.shutdown();
      }
    });
  },
});
