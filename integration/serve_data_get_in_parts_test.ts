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
import { handleHttpRequest } from "../src/serve/http_request_route.ts";
import { SERVE_REQUEST_PATH } from "../src/serve/protocol.ts";
import type { ServerTokenAuthResult } from "../src/serve/token_auth.ts";
import {
  assembleDataGetContent,
  CONTENT_PART_CHARS,
} from "../src/serve/data_get_parts.ts";
import { requestServerResponse } from "../src/cli/remote_run.ts";
import { requestRemoteDataGet } from "../src/cli/commands/data_get.ts";
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

const MODEL = "parts";
// the JSON record spans more than two parts and is mostly escapes; the text one carries astral characters
const RECORDS: { name: string; contentType: string; bytes: Uint8Array }[] = [
  {
    name: "json",
    contentType: "application/json",
    bytes: new TextEncoder().encode(
      JSON.stringify({ blob: '"q"\\'.repeat(CONTENT_PART_CHARS / 2) }),
    ),
  },
  {
    name: "text",
    contentType: "text/plain",
    bytes: new TextEncoder().encode("line   😀\n".repeat(1000)),
  },
  {
    name: "binary",
    contentType: "application/octet-stream",
    bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3]),
  },
];

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
  const model = await saveModel(repo, MODEL);
  for (const record of RECORDS) {
    const data = Data.create({
      name: record.name,
      contentType: record.contentType,
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
      record.bytes,
    );
  }
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
  const frame = frames.find((f) => f.type === "data.get");
  assert(frame);
  return frame;
}

function getPayload(
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { modelIdOrName: MODEL, dataName: name, ...extra };
}

Deno.test("data.get in parts: without inParts the reply is today's single frame, byte for byte", async () => {
  await withServeRepo(async (repo) => {
    await saveRecords(repo);
    const ctx = createServeCtx(repo, readData);
    for (const record of RECORDS) {
      const id = crypto.randomUUID();
      const frames = await sendRequest(ctx, {
        type: "data.get",
        id,
        payload: getPayload(record.name),
      });
      assertEquals(frames.filter((f) => f.type === "data.get.part").length, 0);
      const reply = replyFrame(frames);
      const payload = reply.payload as { data: Record<string, unknown> };
      assertEquals(Object.keys(payload), ["data"]);
      assertEquals(typeof payload.data.content, "string");
      assertEquals(
        JSON.stringify(reply),
        JSON.stringify({ type: "data.get", id, payload }),
      );
    }
  });
});

Deno.test("data.get in parts: the parts reassemble into exactly the single reply, key order included", async () => {
  await withServeRepo(async (repo) => {
    await saveRecords(repo);
    const ctx = createServeCtx(repo, readData);
    for (const record of RECORDS) {
      const whole = (replyFrame(
        await sendRequest(ctx, {
          type: "data.get",
          id: crypto.randomUUID(),
          payload: getPayload(record.name),
        }),
      ).payload as { data: Record<string, unknown> }).data;
      const frames = await sendRequest(ctx, {
        type: "data.get",
        id: crypto.randomUUID(),
        payload: getPayload(record.name, { inParts: true }),
      });
      const terminal = replyFrame(frames);
      assertEquals(frames[frames.length - 1], terminal);
      const parts = frames.filter((f) => f.type === "data.get.part");
      for (const part of parts) {
        const piece = (part.payload as { content: string }).content;
        assertGreater(CONTENT_PART_CHARS + 1, piece.length);
      }
      if (record.name === "json") assertGreater(parts.length, 2);
      const payload = terminal.payload as {
        data: Record<string, unknown>;
        contentParts: number;
        contentLength: number;
      };
      assertEquals(payload.data.content, "");
      assertEquals(payload.contentParts, parts.length);
      const rebuilt = {
        ...payload.data,
        content: assembleDataGetContent(
          parts.map((part) => part.payload),
          payload.contentParts,
          payload.contentLength,
        ),
      };
      assertEquals(JSON.stringify(rebuilt), JSON.stringify(whole));
    }
  });
});

Deno.test("data.get in parts: a read without content sends no parts and today's single reply", async () => {
  await withServeRepo(async (repo) => {
    await saveRecords(repo);
    const ctx = createServeCtx(repo, readData);
    const frames = await sendRequest(ctx, {
      type: "data.get",
      id: crypto.randomUUID(),
      payload: getPayload("json", { includeContent: false, inParts: true }),
    });
    assertEquals(frames.filter((f) => f.type === "data.get.part").length, 0);
    const payload = replyFrame(frames).payload as Record<string, unknown>;
    assertEquals(Object.keys(payload), ["data"]);
    assertEquals(
      (payload.data as Record<string, unknown>).content,
      undefined,
    );
  });
});

Deno.test({
  name:
    "data.get in parts: the CLI client over the HTTP route gets the same data as the single reply",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveRecords(repo);
      const route = startRoute(createServeCtx(repo, readData));
      try {
        const target = { server: route.url, token: "integration-token" };
        for (const record of RECORDS) {
          const whole = await requestServerResponse<
            { data: Record<string, unknown> }
          >(target, { type: "data.get", payload: getPayload(record.name) });
          const inParts = await requestRemoteDataGet(target, {
            modelIdOrName: MODEL,
            dataName: record.name,
          });
          assertEquals(JSON.stringify(inParts), JSON.stringify(whole.data));
        }
        const sent = route.requests.map((r) =>
          (r.payload as Record<string, unknown>).inParts
        );
        assertEquals(sent, RECORDS.flatMap(() => [undefined, true]));
      } finally {
        await route.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "data.get in parts: the new CLI client against a serve that predates inParts reads its single reply",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      await saveRecords(repo);
      const current = startRoute(createServeCtx(repo, readData));
      const older = startRoute(createServeCtx(repo, readData), asOlderServe);
      try {
        for (const record of RECORDS) {
          const payload = { modelIdOrName: MODEL, dataName: record.name };
          const fromOlder = await requestRemoteDataGet(
            { server: older.url, token: "integration-token" },
            payload,
          );
          const fromCurrent = await requestRemoteDataGet(
            { server: current.url, token: "integration-token" },
            payload,
          );
          assertEquals(JSON.stringify(fromOlder), JSON.stringify(fromCurrent));
        }
        for (const request of older.requests) {
          assertEquals(
            (request.payload as Record<string, unknown>).inParts,
            undefined,
          );
        }
      } finally {
        await current.shutdown();
        await older.shutdown();
      }
    });
  },
});
