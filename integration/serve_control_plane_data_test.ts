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
 * Control-plane records — grants, groups, server tokens and the worker
 * fleet's records — are stored as model data, but they are access state, not
 * user data (swamp-club#2756). Served, they are owned by the `access` kind and
 * need `admin`: a principal with read or write on data:* and model:* never
 * sees or changes them through the data requests, and no expression can read
 * them. Requests go through `handleMessage`, the real dispatch path, against
 * a real repository whose control-plane definitions live in the
 * auto-definitions directory, as serve writes them.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveData,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const GRANT_TYPE = ModelType.create("swamp/grant");
const TOKEN_TYPE = ModelType.create("swamp/server-token");

/** Every control-plane record's name starts with this; no user one does. */
const ACL_PREFIX = "acl-";
const GRANT_MODEL = "acl-grant-reader";
const TOKEN_MODEL = "acl-token-ci";
const GRANT_SECRET = "grant-secret-value";
const USER_MODEL = "user-db";

/** Read on data:* and model:* — everything a data reader has. */
const READER: Grant[] = [
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
];

/** Read, write and run on data:* and model:*, but no access grant. */
const WRITER: Grant[] = [
  grant({
    actions: ["read", "write", "run"],
    resource: { kind: "data", pattern: "*" },
  }),
  grant({
    actions: ["read", "write", "run"],
    resource: { kind: "model", pattern: "*" },
  }),
];

/** The superuser: admin on access:*. */
const ADMIN: Grant[] = [
  grant({ actions: ["admin"], resource: { kind: "access", pattern: "*" } }),
];

interface Fixtures {
  repo: ServeRepo;
  grantDef: Definition;
  tokenDef: Definition;
}

/** Saves a control-plane definition where serve mints them. */
async function saveControlPlaneModel(
  repo: ServeRepo,
  type: ModelType,
  name: string,
): Promise<Definition> {
  const autoDefinitions = new YamlDefinitionRepository(
    repo.repoDir,
    undefined,
    join(repo.repoDir, ".swamp", "auto-definitions"),
    false,
  );
  const definition = Definition.create({ name, globalArguments: {} });
  await autoDefinitions.save(type, definition);
  return definition;
}

/** Saves one version of a control-plane record owned by `model`. */
async function saveControlPlaneData(
  repo: ServeRepo,
  type: ModelType,
  model: Definition,
  dataName: string,
  content: Record<string, unknown>,
): Promise<void> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: model.name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${type.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    type,
    model.id,
    data,
    new TextEncoder().encode(JSON.stringify(content)),
  );
}

async function withFixtures(fn: (f: Fixtures) => Promise<void>) {
  await withServeRepo(async (repo) => {
    const grantDef = await saveControlPlaneModel(
      repo,
      GRANT_TYPE,
      GRANT_MODEL,
    );
    await saveControlPlaneData(repo, GRANT_TYPE, grantDef, "grant-main", {
      id: crypto.randomUUID(),
      secret: GRANT_SECRET,
    });
    const tokenDef = await saveControlPlaneModel(
      repo,
      TOKEN_TYPE,
      TOKEN_MODEL,
    );
    await saveControlPlaneData(repo, TOKEN_TYPE, tokenDef, "token-main", {
      tokenHash: "hash-of-token",
    });
    const userModel = await saveModel(repo, USER_MODEL);
    await saveData(repo, userModel, "state");
    await fn({ repo, grantDef, tokenDef });
  });
}

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

function reply(frames: Frame[], type: string): string {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const found = frames.find((frame) => frame.type === type);
  assert(found, `${type} replied: ${JSON.stringify(frames)}`);
  return JSON.stringify(found);
}

function assertRefusedAsAdmin(frames: Frame[], label: string) {
  const error = errorFrame(frames);
  assertEquals(error?.error?.code, "unauthorized", JSON.stringify(frames));
  assertStringIncludes(error!.error!.message, "'admin'", label);
  assertStringIncludes(error!.error!.message, "access:swamp/", label);
}

const COLLECTIONS = [
  ["data.search", {}],
  ["data.query", { predicate: "true" }],
  ["data.query", { predicate: "true", select: "modelName" }],
] as const;

Deno.test("serve control-plane data: data collections leave out control-plane records for a data reader", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, READER);
    for (const [type, payload] of COLLECTIONS) {
      const label = `${type} ${JSON.stringify(payload)}`;
      const body = reply(await sendRequest(ctx, request(type, payload)), type);
      assert(body.includes(USER_MODEL), `${label}: ${body}`);
      assert(!body.includes(ACL_PREFIX), `${label}: ${body}`);
      assert(!body.includes(GRANT_SECRET), `${label}: ${body}`);
    }
  });
});

Deno.test("serve control-plane data: an access admin sees control-plane records in data.search", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, ADMIN);
    const body = reply(
      await sendRequest(ctx, request("data.search", {})),
      "data.search",
    );
    assert(body.includes(GRANT_MODEL), body);
    assert(body.includes(TOKEN_MODEL), body);
    assert(body.includes(USER_MODEL), body);
  });
});

Deno.test("serve control-plane data: reading a grant record needs admin on access", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, READER);
    for (const modelIdOrName of [GRANT_MODEL, f.grantDef.id]) {
      for (
        const [type, payload] of [
          ["data.get", { modelIdOrName, dataName: "grant-main" }],
          ["data.versions", { modelIdOrName, dataName: "grant-main" }],
          ["data.list", { modelIdOrName }],
        ] as const
      ) {
        const label = `${type} ${JSON.stringify(payload)}`;
        const frames = await sendRequest(ctx, request(type, payload));
        assertRefusedAsAdmin(frames, label);
        assert(!JSON.stringify(frames).includes(GRANT_SECRET), label);
      }
    }
    // The user model's data stays readable with the same grants.
    reply(
      await sendRequest(
        ctx,
        request("data.get", { modelIdOrName: USER_MODEL, dataName: "state" }),
      ),
      "data.get",
    );
  });
});

Deno.test("serve control-plane data: an access admin reads a grant record with data.get", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, ADMIN);
    const body = reply(
      await sendRequest(
        ctx,
        request("data.get", {
          modelIdOrName: GRANT_MODEL,
          dataName: "grant-main",
        }),
      ),
      "data.get",
    );
    assert(body.includes(GRANT_SECRET), body);
  });
});

Deno.test("serve control-plane data: write on data:* cannot delete or rename a server-token record", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, WRITER);
    for (
      const [type, payload] of [
        ["data.delete", { modelIdOrName: TOKEN_MODEL, dataName: "token-main" }],
        ["data.rename", {
          modelIdOrName: TOKEN_MODEL,
          oldName: "token-main",
          newName: "token-renamed",
        }],
      ] as const
    ) {
      assertRefusedAsAdmin(
        await sendRequest(ctx, request(type, payload)),
        type,
      );
    }
    const versions = await f.repo.repoContext.unifiedDataRepo.listVersions(
      TOKEN_TYPE,
      f.tokenDef.id,
      "token-main",
    );
    assertEquals(versions.length, 1, "the token record is untouched");
  });
});

Deno.test("serve control-plane data: write on model:* cannot edit a control-plane definition", async () => {
  await withFixtures(async (f) => {
    const ctx = createServeCtx(f.repo, WRITER);
    assertRefusedAsAdmin(
      await sendRequest(
        ctx,
        request("model.edit", {
          modelIdOrName: TOKEN_MODEL,
          content: stringifyYaml({
            ...JSON.parse(JSON.stringify(f.tokenDef.toData())),
            tags: { retagged: "true" },
          }),
        }),
      ),
      "model.edit",
    );
    const token = await f.repo.repoContext.definitionRepo.findByNameGlobal(
      TOKEN_MODEL,
    );
    assertEquals(token?.definition.tags ?? {}, {}, "the token is untouched");
  });
});

Deno.test("serve control-plane data: model.evaluate expressions cannot read a grant record", async () => {
  await withFixtures(async (f) => {
    // A user model whose argument reads the grant record through the data
    // namespace, and one reading user data as a control.
    const leak = Definition.create({
      name: "user-leak",
      globalArguments: {
        grant:
          `\${{ data.latest("${GRANT_MODEL}", "grant-main").attributes.secret }}`,
        user: `\${{ data.latest("${USER_MODEL}", "state").attributes.value }}`,
      },
    });
    await f.repo.repoContext.definitionRepo.save(f.repo.modelType, leak);
    for (const grants of [READER, ADMIN]) {
      const frames = await sendRequest(
        createServeCtx(f.repo, grants),
        request("model.evaluate", { modelIdOrName: "user-leak" }),
      );
      const body = reply(frames, "model.evaluate");
      assert(!body.includes(GRANT_SECRET), body);
      const args = (frames.find((frame) => frame.type === "model.evaluate")!
        .payload!.data as { globalArguments: Record<string, unknown> })
        .globalArguments;
      // The data namespace itself works: the user record resolves.
      assertEquals(args.user, "state", body);
      assert(args.grant !== GRANT_SECRET, body);
    }
  });
});
