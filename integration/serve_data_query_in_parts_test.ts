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

import { assert, assertEquals, assertGreater } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { MAX_ACTIVE_REQUESTS } from "../src/serve/connection.ts";
import { handleHttpRequest } from "../src/serve/http_request_route.ts";
import { SERVE_REQUEST_PATH } from "../src/serve/protocol.ts";
import type { ServerTokenAuthResult } from "../src/serve/token_auth.ts";
import {
  assembleQueryReply,
  QUERY_PART_BUDGET_BYTES,
} from "../src/serve/data_query_parts.ts";
import type { DataQueryData } from "../src/libswamp/data/query.ts";
import { requestServerResponse } from "../src/cli/remote_run.ts";
import { requestRemoteQuery } from "../src/cli/commands/data_query.ts";
import {
  CALLER,
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const RECORDS = 6;
// six of these fill more than two parts
const BLOB_CHARS = 1536 * 1024;
const PREDICATE = 'modelName == "parts"';
const SELECTS = [undefined, "content", "name", "[name, version]"];

const readData = [
  grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

const callerToken: ServerTokenAuthResult = {
  ok: true,
  principalId: `${CALLER.kind}:${CALLER.id}`,
  collectives: [],
  groups: [],
  tokenName: "integration",
  tokenCreatedAt: "2026-11-01T00:00:00.000Z",
};

async function saveRecords(repo: ServeRepo): Promise<void> {
  const model = await saveModel(repo, "parts");
  for (let i = 0; i < RECORDS; i++) {
    const data = Data.create({
      name: `record-${i}`,
      contentType: "application/json",
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
      new TextEncoder().encode(
        JSON.stringify({ i, blob: String(i).repeat(BLOB_CHARS) }),
      ),
    );
  }
}

function queryPayload(select: string | undefined): Record<string, unknown> {
  return select === undefined
    ? { predicate: PREDICATE }
    : { predicate: PREDICATE, select };
}

function startRoute(
  ctx: ConnectionContext,
  rewrite: (body: Record<string, unknown>) => Record<string, unknown> = (b) =>
    b,
): {
  url: string;
  requests: Record<string, unknown>[];
  shutdown(): Promise<void>;
} {
  const requests: Record<string, unknown>[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      if (new URL(req.url).pathname !== SERVE_REQUEST_PATH) {
        return new Response("Not found", { status: 404 });
      }
      const body = rewrite(await req.json());
      requests.push(body);
      return handleHttpRequest(
        new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(body),
        }),
        "127.0.0.1",
        { ctx, authenticate: () => Promise.resolve(callerToken) },
      );
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    requests,
    shutdown: () => server.shutdown(),
  };
}

// an older serve's schema drops a key it does not know
function asOlderServe(body: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...(body.payload as Record<string, unknown>) };
  delete payload.inParts;
  return { ...body, payload };
}

function replyFrame(frames: Frame[]): Frame {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === "data.query");
  assert(frame);
  return frame;
}

Deno.test("data.query in parts: without inParts the reply is today's single frame, byte for byte", async () => {
  await withServeRepo(async (repo) => {
    await saveRecords(repo);
    const ctx = createServeCtx(repo, readData);
    for (const select of SELECTS) {
      const id = crypto.randomUUID();
      const frames = await sendRequest(ctx, {
        type: "data.query",
        id,
        payload: queryPayload(select),
      });
      assertEquals(frames.filter((f) => f.type === "data.query.part"), []);
      const reply = replyFrame(frames);
      const payload = reply.payload as Record<string, unknown>;
      assertEquals(Object.keys(payload), ["data"]);
      assertEquals(
        JSON.stringify(reply),
        JSON.stringify({ type: "data.query", id, payload }),
      );
    }
  });
});

Deno.test("data.query in parts: the parts reassemble into exactly the single reply, for every result shape", async () => {
  await withServeRepo(async (repo) => {
    await saveRecords(repo);
    const ctx = createServeCtx(repo, readData);
    for (const select of SELECTS) {
      const whole = replyFrame(
        await sendRequest(ctx, {
          type: "data.query",
          id: crypto.randomUUID(),
          payload: queryPayload(select),
        }),
      );
      const frames = await sendRequest(ctx, {
        type: "data.query",
        id: crypto.randomUUID(),
        payload: { ...queryPayload(select), inParts: true },
      });
      const terminal = replyFrame(frames);
      assertEquals(frames[frames.length - 1], terminal);
      const parts = frames.filter((f) => f.type === "data.query.part");
      for (const part of parts) {
        assertGreater(
          QUERY_PART_BUDGET_BYTES + 1024,
          JSON.stringify(part).length,
        );
      }
      if (select === "content") assertGreater(parts.length, 2);
      const payload = terminal.payload as {
        data: DataQueryData;
        partItems: number;
      };
      assertEquals(payload.partItems, RECORDS);
      assertEquals(
        assembleQueryReply(
          payload.data,
          parts.map((part) => part.payload),
          payload.partItems,
        ),
        (whole.payload as { data: DataQueryData }).data,
      );
    }
  });
});

Deno.test({
  name:
    "data.query in parts: the CLI client over the HTTP route gets the same results as the single reply",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveRecords(repo);
      const route = startRoute(createServeCtx(repo, readData));
      try {
        for (const select of SELECTS) {
          const target = { server: route.url, token: "integration-token" };
          const whole = await requestServerResponse<{ data: DataQueryData }>(
            target,
            { type: "data.query", payload: queryPayload(select) },
          );
          const inParts = await requestRemoteQuery(target, {
            predicate: PREDICATE,
            ...(select !== undefined && { select }),
          });
          assertEquals(inParts, whole.data);
        }
        const sent = route.requests.map((r) =>
          (r.payload as Record<string, unknown>).inParts
        );
        assertEquals(sent, SELECTS.flatMap(() => [undefined, true]));
      } finally {
        await route.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "data.query in parts: the new CLI client against a serve that predates inParts reads its single reply",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveRecords(repo);
      const current = startRoute(createServeCtx(repo, readData));
      const older = startRoute(createServeCtx(repo, readData), asOlderServe);
      try {
        const payload = { predicate: PREDICATE, select: "content" };
        const fromOlder = await requestRemoteQuery(
          { server: older.url, token: "integration-token" },
          payload,
        );
        const fromCurrent = await requestRemoteQuery(
          { server: current.url, token: "integration-token" },
          payload,
        );
        assertEquals(fromOlder, fromCurrent);
        assertEquals(fromOlder.projected?.shape, "map");
        assertEquals(
          (older.requests[0].payload as Record<string, unknown>).inParts,
          undefined,
        );
      } finally {
        await current.shutdown();
        await older.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "data.query in parts: a reply in parts frees its HTTP slot, so more than the slot cap run back to back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveModel(repo, "parts");
      const route = startRoute(createServeCtx(repo, readData));
      try {
        for (let i = 0; i <= MAX_ACTIVE_REQUESTS; i++) {
          await requestRemoteQuery(
            { server: route.url, token: "integration-token" },
            { predicate: PREDICATE, select: "name" },
          );
        }
      } finally {
        await route.shutdown();
      }
    });
  },
});
