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

import { assert, assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const SECRET = "orphaned-secret-value";

// data outlives its behavior: no definition is ever saved for the name
async function saveOrphaned(
  repo: ServeRepo,
  modelName: string,
  type: ModelType = repo.modelType,
): Promise<string> {
  const modelId = crypto.randomUUID();
  await repo.repoContext.unifiedDataRepo.save(
    type,
    modelId,
    Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${type.normalized}:${modelId}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify({ value: SECRET })),
  );
  return modelId;
}

const dataReader = (pattern: string, extra: Grant[] = []): Grant[] => [
  grant({ actions: ["read"], resource: { kind: "data", pattern } }),
  ...extra,
];

async function request(
  ctx: ConnectionContext,
  type: "data.get" | "data.versions" | "data.list",
  modelIdOrName: string,
): Promise<Frame[]> {
  const payload = type === "data.list"
    ? { modelIdOrName }
    : { modelIdOrName, dataName: "result" };
  return await sendRequest(ctx, {
    type,
    id: crypto.randomUUID(),
    payload,
  });
}

function reply(frames: Frame[], type: string): Record<string, unknown> {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const found = frames.find((frame) => frame.type === type);
  assert(found, JSON.stringify(frames));
  return (found.payload as { data: Record<string, unknown> }).data;
}

Deno.test("serve data reads: get, versions and list read a behavior's data after its definition is gone", async () => {
  await withServeRepo(async (repo) => {
    const name = `orphan-${crypto.randomUUID()}`;
    const modelId = await saveOrphaned(repo, name);
    const ctx = createServeCtx(repo, dataReader("orphan-*"));

    const got = reply(await request(ctx, "data.get", name), "data.get");
    assertEquals(got.modelId, modelId);
    assertEquals(got.modelName, name);
    assert(String(got.content).includes(SECRET));

    const versions = reply(
      await request(ctx, "data.versions", name),
      "data.versions",
    );
    assertEquals([versions.modelId, versions.total], [modelId, 1]);

    const listed = reply(await request(ctx, "data.list", name), "data.list");
    assertEquals([listed.modelId, listed.total], [modelId, 1]);
  });
});

Deno.test("serve data reads: an orphaned owner is authorized on its recorded name and type", async () => {
  await withServeRepo(async (repo) => {
    const name = `orphan-${crypto.randomUUID()}`;
    const modelId = await saveOrphaned(repo, name);

    const otherName = createServeCtx(repo, dataReader("someone-else-*"));
    // a deny the raw name cannot meet: it has no namespace, the recorded type has
    const typeDenied = createServeCtx(
      repo,
      dataReader("*", [
        grant({
          effect: "deny",
          actions: ["read"],
          resource: { kind: "data", pattern: "*" },
          condition: 'ns == "test"',
        }),
      ]),
    );
    for (const ctx of [otherName, typeDenied]) {
      for (const type of ["data.get", "data.versions", "data.list"] as const) {
        const frames = await request(ctx, type, name);
        assert(errorFrame(frames), JSON.stringify(frames));
        const body = JSON.stringify(frames);
        assert(!body.includes(SECRET), body);
        assert(!body.includes(modelId), body);
      }
    }
  }, { scopedType: true });
});

Deno.test("serve data reads: an orphaned control-plane record is never read as plain data", async () => {
  await withServeRepo(async (repo) => {
    const name = `orphan-${crypto.randomUUID()}`;
    const modelId = await saveOrphaned(
      repo,
      name,
      ModelType.create("@swamp/grant"),
    );
    const frames = await request(
      createServeCtx(repo, dataReader("*")),
      "data.get",
      name,
    );
    assert(errorFrame(frames), JSON.stringify(frames));
    const body = JSON.stringify(frames);
    assert(!body.includes(SECRET), body);
    assert(!body.includes(modelId), body);
  });
});

Deno.test("serve data reads: a name recorded under several owners is refused, naming only owners the caller may read", async () => {
  await withServeRepo(async (repo) => {
    const name = `orphan-${crypto.randomUUID()}`;
    const scoped = await saveOrphaned(repo, name);
    const plain = await saveOrphaned(
      repo,
      name,
      ModelType.create(`plain/serve-${crypto.randomUUID().slice(0, 8)}`),
    );
    const plainSecond = await saveOrphaned(
      repo,
      name,
      ModelType.create(`plain/serve-${crypto.randomUUID().slice(0, 8)}`),
    );

    const everything = await request(
      createServeCtx(repo, dataReader("*")),
      "data.get",
      name,
    );
    const refused = errorFrame(everything);
    assert(refused, JSON.stringify(everything));
    const body = JSON.stringify(refused);
    for (const id of [scoped, plain, plainSecond]) {
      assert(body.includes(id), body);
    }
    assert(body.includes("validation_failed"), body);

    // the scoped owner is unreadable, so it is never named
    const scopedDenied = await request(
      createServeCtx(
        repo,
        dataReader("*", [
          grant({
            effect: "deny",
            actions: ["read"],
            resource: { kind: "data", pattern: "*" },
            condition: 'ns == "test"',
          }),
        ]),
      ),
      "data.get",
      name,
    );
    const hidden = JSON.stringify(scopedDenied);
    assert(errorFrame(scopedDenied), hidden);
    assert(!hidden.includes(scoped), hidden);
    assert(hidden.includes(plain) && hidden.includes(plainSecond), hidden);
  }, { scopedType: true });
});

Deno.test("serve data reads: one readable owner among several is read, and the audit names it", async () => {
  await withServeRepo(async (repo) => {
    const name = `orphan-${crypto.randomUUID()}`;
    await saveOrphaned(repo, name);
    const plain = await saveOrphaned(
      repo,
      name,
      ModelType.create(`plain/serve-${crypto.randomUUID().slice(0, 8)}`),
    );
    const events: AuditEvent[] = [];
    const ctx = {
      ...createServeCtx(
        repo,
        dataReader("*", [
          grant({
            effect: "deny",
            actions: ["read"],
            resource: { kind: "data", pattern: "*" },
            condition: 'ns == "test"',
          }),
        ]),
      ),
      auditEmitter: {
        emit: (event: AuditEvent) => events.push(event),
      } as unknown as AuditEmitter,
    } as ConnectionContext;

    const got = reply(await request(ctx, "data.get", name), "data.get");
    assertEquals(got.modelId, plain);
    const audited = events.filter((event) => event.resourceKind === "data");
    assert(audited.length > 0, JSON.stringify(events));
    assert(
      audited.every((event) => event.resourceName === name),
      JSON.stringify(audited),
    );
  }, { scopedType: true });
});

Deno.test("serve data reads: a failed owner lookup is reported only to a caller allowed the name as sent", async () => {
  await withServeRepo(async (repo) => {
    const failing = (grants: Grant[]): ConnectionContext => {
      const ctx = createServeCtx(repo, grants);
      return {
        ...ctx,
        repoContext: {
          ...ctx.repoContext,
          dataQueryService: {
            findRecordedOwners: () =>
              Promise.reject(new Error("catalog-lookup-broke")),
          },
        },
      } as unknown as ConnectionContext;
    };
    const name = `orphan-${crypto.randomUUID()}`;

    const denied = JSON.stringify(
      await request(failing(dataReader("someone-else-*")), "data.get", name),
    );
    assert(denied.includes('"type":"error"'), denied);
    assert(!denied.includes("catalog-lookup-broke"), denied);

    const allowed = JSON.stringify(
      await request(failing(dataReader("orphan-*")), "data.get", name),
    );
    assert(allowed.includes("data_get_failed"), allowed);
  });
});
