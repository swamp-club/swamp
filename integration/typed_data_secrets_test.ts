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
 * Typed data secrets end to end (design/enablers/typed-secrets.md Sections
 * 3.4 and 6.1, typed-secrets 3.3), through real components in process: the
 * resource writer stores sensitive fields in a counting vault on a temp
 * repository; a real resolver context reads them on the typed path as
 * data-origin references with no vault read; the run's vault access
 * authorizes each reference after evaluation; and the loader delivers the
 * exact value once at delivery. The option-off path, `readResource` and raw
 * content are pinned unchanged beside it.
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  InvalidExpressionError,
  SECRET_OPERATION_UNSUPPORTED,
  SECRET_REFERENCE_INVALID,
  SecretRefusedError,
} from "../src/domain/expressions/errors.ts";
import {
  type ExpressionContext,
  ModelResolver,
} from "../src/domain/expressions/model_resolver.ts";
import {
  createResourceReader,
  createResourceWriter,
  sanitizeVaultKey,
  SENSITIVE_FIELDS_TAG,
} from "../src/domain/models/data_writer.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RunSensitiveValues } from "../src/domain/secrets/mod.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
  VaultAccessDeniedError,
} from "../src/domain/vaults/run_vault_access.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  CelEvaluator,
  type EvaluationScope,
} from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  type CatalogRow,
  CatalogStore,
} from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import {
  type CountingVault,
  generateCanaries,
  registerCountingVault,
} from "./canary_values.ts";

const TYPE = ModelType.create("test/typed-data");
const VAULT = "prod";
const METHOD = "run";
const FOREIGN_REFERENCE = "${{ vault.get('prod', 'theirs') }}";

const owner = { ownerType: "model-method" as const, ownerRef: "test" };

const resources: Record<string, ResourceOutputSpec> = {
  creds: {
    schema: z.object({
      password: z.string().meta({ sensitive: true }),
      user: z.string(),
      nested: z.object({
        token: z.string().meta({ sensitive: true }),
        plain: z.string(),
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
  all: {
    schema: z.object({ a: z.string(), b: z.string() }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,
  },
  one: {
    schema: z.object({ secret: z.string().meta({ sensitive: true }) }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
};

interface Fixture {
  repoDir: string;
  modelId: string;
  orphanId: string;
  dataRepo: FileSystemUnifiedDataRepository;
  catalog: CatalogStore;
  /** The raw query service, as the command and the extension API use it. */
  dqs: DataQueryService;
  vaultService: VaultService;
  counting: CountingVault;
  secrets: {
    password: string;
    token: string;
    a: string;
    b: string;
    orphan: string;
  };
  context: ExpressionContext;
  bag: VaultSecretBag;
  scope: EvaluationScope;
  evaluator: CelEvaluator;
  loader: SecretLoader;
  redacted: string[];
  evaluate: (expression: string, scope?: EvaluationScope) => Promise<unknown>;
  write: (
    modelId: string,
    definitionName: string,
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  /** Writes a record below the writer, as stored, with the given tags. */
  store: (
    name: string,
    tags: Record<string, string>,
    content: string,
    contentType?: string,
  ) => Promise<void>;
  /** Repopulates the catalog after direct stores. */
  sync: () => Promise<void>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const counting = registerCountingVault({});
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3626-" });
  const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    await ensureDir(join(repoDir, ".swamp", "data"));
    await ensureDir(join(repoDir, "models"));
    await ensureDir(join(repoDir, "vaults"));
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: VAULT,
      type: counting.type,
      config: {},
    });

    const defRepo = new YamlDefinitionRepository(repoDir);
    const foreignContent = new TextEncoder().encode(
      JSON.stringify({ password: FOREIGN_REFERENCE, user: "them" }),
    );
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
      undefined,
      undefined,
      SOLO_NAMESPACE,
      undefined,
      undefined,
      (namespace) =>
        Promise.resolve(namespace === "security" ? foreignContent : null),
    );
    const dqs = new DataQueryService(catalog, dataRepo);

    const db = Definition.create({ name: "db" });
    await defRepo.save(TYPE, db);
    const orphanId = crypto.randomUUID();

    const write: Fixture["write"] = async (
      modelId,
      definitionName,
      spec,
      name,
      data,
    ) => {
      const writer = createResourceWriter(
        dataRepo,
        TYPE,
        modelId,
        resources,
        undefined,
        undefined,
        undefined,
        undefined,
        definitionName,
        vaultService,
        METHOD,
      );
      await writer.writeResource(spec, name, data);
    };
    const store: Fixture["store"] = async (
      name,
      tags,
      content,
      contentType = "application/json",
    ) => {
      await dataRepo.save(
        TYPE,
        db.id,
        Data.create({
          name,
          contentType,
          lifetime: "infinite",
          garbageCollection: 10,
          tags: {
            type: "resource",
            modelName: "db",
            specName: "creds",
            ...tags,
          },
          ownerDefinition: owner,
        }),
        new TextEncoder().encode(content),
      );
    };
    const sync = async () => {
      await dqs.query('name == ""');
    };

    const secrets = {
      password: `pw-${crypto.randomUUID()}`,
      token: `tk-${crypto.randomUUID()}`,
      a: `a-${crypto.randomUUID()}`,
      b: `b-${crypto.randomUUID()}`,
      orphan: `orphan-${crypto.randomUUID()}`,
    };
    await write(db.id, "db", "creds", "main", {
      password: secrets.password,
      user: "u",
      nested: { token: secrets.token, plain: "p" },
    });
    await write(db.id, "db", "all", "every", { a: secrets.a, b: secrets.b });
    await write(orphanId, "orphan", "creds", "main", {
      password: secrets.orphan,
      user: "o",
      nested: { token: "t", plain: "p" },
    });
    await sync();

    // A record another namespace exported, as a catalog pull stores it.
    catalog.markPopulated();
    catalog.upsert(foreignRow(db.id));

    const resolver = new ModelResolver(defRepo, {
      repoDir,
      dataRepo,
      dataQueryService: dqs,
      vaultService,
    });
    const context = await resolver.buildContext(new RunSensitiveValues());
    const bag = new VaultSecretBag(new SecretBagRegistry());
    const redacted: string[] = [];
    const scope: EvaluationScope = {
      secretBag: bag,
      vault: {
        service: vaultService,
        redactor: { addSecret: (value) => redacted.push(value) },
        location: "inputs.cmd",
      },
    };
    const evaluator = new CelEvaluator({ typedSecrets: true });
    const loader = new SecretLoader(() => Promise.resolve(vaultService), {
      addSecret: (value) => redacted.push(value),
    });
    const fixture: Fixture = {
      repoDir,
      modelId: db.id,
      orphanId,
      dataRepo,
      catalog,
      dqs,
      vaultService,
      counting,
      secrets,
      context,
      bag,
      scope,
      evaluator,
      loader,
      redacted,
      evaluate: (expression, s = scope) =>
        evaluator.evaluateAsync(
          expression,
          context as unknown as Record<string, unknown>,
          s,
        ),
      write,
      store,
      sync,
    };
    await runWithVaultAccess(
      RunVaultAccess.create({ allowedVaults: [VAULT] }),
      () => fn(fixture),
    );
  } finally {
    counting.dispose();
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function foreignRow(modelId: string): CatalogRow {
  return {
    namespace: "security",
    type_normalized: TYPE.normalized,
    model_id: modelId,
    data_name: "theirs",
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "db",
    spec_name: "creds",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: "model-method",
    streaming: 0,
    size: 2,
    created_at: new Date().toISOString(),
    tags: JSON.stringify({
      type: "resource",
      modelName: "db",
      specName: "creds",
      [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]),
    }),
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

/** The vault key the writer stored `field` of `spec`/`instance` under. */
function keyOf(
  modelId: string,
  spec: string,
  instance: string,
  field: string,
): string {
  return sanitizeVaultKey(
    `${TYPE.normalized}/${modelId}/${METHOD}/${spec}/${instance}/${field}`,
  );
}

function sentinelOf(f: Fixture, value: unknown): string {
  assert(typeof value === "string", `not a sentinel: ${Deno.inspect(value)}`);
  const entry = f.bag.registry.issuedEntryOf(value);
  assert(entry !== undefined, "not a sentinel the run issued");
  assertEquals(entry.dataOrigin, true);
  assertEquals("value" in entry, false);
  return value;
}

Deno.test("typed data secrets: own-namespace reads on every accessor return data-origin references with no vault read, and the loader delivers each exactly once", async () => {
  await withFixture(async (f) => {
    const reads: Record<string, string> = {
      latest: sentinelOf(
        f,
        await f.evaluate("data.latest('db', 'main').attributes.password"),
      ),
      nested: sentinelOf(
        f,
        await f.evaluate("data.latest('db', 'main').attributes.nested.token"),
      ),
      version: sentinelOf(
        f,
        await f.evaluate("data.version('db', 'main', 1).attributes.password"),
      ),
      findBySpec: sentinelOf(
        f,
        await f.evaluate(
          "data.findBySpec('db', 'creds')[0].attributes.password",
        ),
      ),
      findByTag: sentinelOf(
        f,
        await f.evaluate(
          "data.findByTag('modelName', 'db').filter(r, r.specName == 'creds')[0].attributes.password",
        ),
      ),
      model: sentinelOf(
        f,
        await f.evaluate(
          "model.db.resource.creds.main.attributes.password",
        ),
      ),
      star: sentinelOf(
        f,
        await f.evaluate("data.latest('db', 'every').attributes.a"),
      ),
      orphan: sentinelOf(
        f,
        await f.evaluate("data.latest('orphan', 'main').attributes.password"),
      ),
      // data.query in both forms (typed-secrets 4.3): records answered
      // whole, an empty select, and projections of a field, a container
      // and JSON content.
      query: sentinelOf(
        f,
        await f.evaluate(
          `data.query('modelName == "db" && name == "main"')[0].attributes.password`,
        ),
      ),
      queryEmptySelect: sentinelOf(
        f,
        await f.evaluate(
          `data.query('modelName == "db" && name == "main"', '')[0].attributes.password`,
        ),
      ),
      queryProjected: sentinelOf(
        f,
        await f.evaluate(
          `data.query('modelName == "db" && name == "main"', 'attributes.password')[0]`,
        ),
      ),
      queryContainer: sentinelOf(
        f,
        await f.evaluate(
          `data.query('modelName == "db" && name == "main"', 'attributes')[0].nested.token`,
        ),
      ),
      queryContent: sentinelOf(
        f,
        await f.evaluate(
          `data.query('modelName == "db" && name == "main"', 'content')[0].password`,
        ),
      ),
    };
    assertEquals(
      await f.evaluate(
        `data.query('modelName == "db" && name == "main"', 'attributes.user')`,
      ),
      ["u"],
    );
    // Non-secret structure is unchanged, and a whole record leaves plain.
    assertEquals(
      await f.evaluate("data.latest('db', 'main').attributes.user"),
      "u",
    );
    assertEquals(
      await f.evaluate("data.latest('db', 'main').attributes.nested.plain"),
      "p",
    );
    const whole = await f.evaluate("data.latest('db', 'main')") as DataRecord;
    assertEquals(whole.name, "main");
    assertEquals(Object.keys(whole.attributes).sort(), [
      "nested",
      "password",
      "user",
    ]);
    sentinelOf(f, whole.attributes.password);
    assertEquals(whole.content, whole.attributes);
    structuredClone(whole);
    const everyone = await f.evaluate(
      "data.findBySpec('db', 'creds')",
    ) as DataRecord[];
    assertEquals(everyone.map((r) => r.name), ["main"]);

    assertEquals(f.counting.reads, []);
    assertEquals(f.bag.rawValues, []);
    assertEquals(f.redacted, []);

    const loaded = await f.loader.load(f.bag, reads);
    assertEquals(loaded.resolveDeep(reads), {
      latest: f.secrets.password,
      nested: f.secrets.token,
      version: f.secrets.password,
      findBySpec: f.secrets.password,
      findByTag: f.secrets.password,
      model: f.secrets.password,
      star: f.secrets.a,
      orphan: f.secrets.orphan,
      query: f.secrets.password,
      queryEmptySelect: f.secrets.password,
      queryProjected: f.secrets.password,
      queryContainer: f.secrets.token,
      queryContent: f.secrets.password,
    });
    // One read per distinct reference, not per sentinel.
    assertEquals(
      f.counting.reads.map((read) => read.key).sort(),
      [
        keyOf(f.modelId, "all", "every", "a"),
        keyOf(f.modelId, "creds", "main", "nested.token"),
        keyOf(f.modelId, "creds", "main", "password"),
        keyOf(f.orphanId, "creds", "main", "password"),
      ].sort(),
    );
    assertEquals(
      f.redacted.sort(),
      [
        f.secrets.a,
        f.secrets.orphan,
        f.secrets.password,
        f.secrets.token,
      ].sort(),
    );
    assertEquals(f.bag.rawValues, []);
  });
});

Deno.test("typed data secrets: every canary class is held as a reference and delivered exactly", async () => {
  await withFixture(async (f) => {
    for (const canary of generateCanaries()) {
      const name = `canary-${canary.class}`;
      await f.write(f.modelId, "db", "one", name, { secret: canary.value });
      await f.sync();
      const before = f.counting.reads.length;
      const sentinel = sentinelOf(
        f,
        await f.evaluate(`data.latest('db', '${name}').attributes.secret`),
      );
      assertEquals(f.counting.reads.length, before, canary.class);
      const loaded = await f.loader.load(f.bag, { secret: sentinel });
      assertEquals(
        loaded.resolveDeep({ secret: sentinel }),
        { secret: canary.value },
        canary.class,
      );
      assertEquals(f.counting.reads.length, before + 1, canary.class);
      if (canary.unique) {
        assertEquals(sentinel.includes(canary.value), false, canary.class);
      }
    }
  });
});

Deno.test("typed data secrets: denied and revoked access fail before the result is used, a missing key fails only at load, and a foreign record stays as stored", async () => {
  await withFixture(async (f) => {
    const denying = RunVaultAccess.create({
      allowedVaults: ["other"],
      allowListSource: "deploy",
    });
    await runWithVaultAccess(denying, async () => {
      // The expression selects a field that is not secret; the record's
      // references are still authorized.
      const error = await assertRejects(
        () => f.evaluate("data.latest('db', 'main').attributes.user"),
        InvalidExpressionError,
      );
      assertInstanceOf(error.cause, VaultAccessDeniedError);
      assertStringIncludes(error.message, "Reading vault 'prod' is refused");
      // A set read fails on any returned record's reference.
      await assertRejects(
        () => f.evaluate("size(data.findBySpec('db', 'creds'))"),
        InvalidExpressionError,
      );
      // A query fails on a record it answers or a projection reads, and not
      // on a row its predicate read but did not match: that row's references
      // stay with the row (typed-secrets 4.3).
      await assertRejects(
        () =>
          f.evaluate(
            `data.query('modelName == "db" && name == "main"')[0].attributes.user`,
          ),
        InvalidExpressionError,
        "Reading vault 'prod' is refused",
      );
      await assertRejects(
        () =>
          f.evaluate(
            `data.query('modelName == "db" && name == "main"', 'attributes.user')`,
          ),
        InvalidExpressionError,
        "Reading vault 'prod' is refused",
      );
      assertEquals(
        await f.evaluate(
          `size(data.query('modelName == "db" && attributes.password != null && name == "nope"'))`,
        ),
        0,
      );
    });
    assertEquals(f.counting.reads, []);

    let allowed = true;
    const revocable = RunVaultAccess.create({
      policy: {
        principal: "user:tester",
        decide: () => ({
          allowed,
          reason: allowed ? "granted" : "revoked mid-run",
        }),
      },
    });
    await runWithVaultAccess(revocable, async () => {
      assertEquals(
        await f.evaluate("data.latest('db', 'main').attributes.user"),
        "u",
      );
      allowed = false;
      await assertRejects(
        () => f.evaluate("data.latest('db', 'main').attributes.user"),
        InvalidExpressionError,
        "revoked mid-run",
      );
    });

    // A reference to a key the vault does not hold is a reference until it
    // is delivered.
    await f.store("gone", {
      [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]),
    }, JSON.stringify({ password: "${{ vault.get('prod', 'no-such-key') }}" }));
    await f.sync();
    const gone = sentinelOf(
      f,
      await f.evaluate("data.latest('db', 'gone').attributes.password"),
    );
    assertEquals(f.counting.reads, []);
    const failed = await assertRejects(
      () => f.loader.load(f.bag, { password: gone }),
      Error,
      "Failed to load secret 'no-such-key' from vault 'prod' (at data.latest of model 'db' record ",
    );
    assertStringIncludes(failed.message, "field 'password'");
    assertEquals(failed.message.includes("gone"), false);
    assertEquals(f.counting.readsOf("no-such-key"), 1);

    // Another namespace's record is returned as stored: its reference text
    // is text, nothing is recorded, and no scope is needed.
    const theirs = await f.evaluate(
      "data.latest('security:db', 'theirs')",
      { secretBag: f.bag },
    ) as DataRecord;
    assertEquals(theirs.namespace, "security");
    assertEquals(theirs.attributes, {
      password: FOREIGN_REFERENCE,
      user: "them",
    });
    assertEquals(
      await f.evaluate(
        "data.latest('security:db', 'theirs').attributes.password",
        {
          secretBag: f.bag,
        },
      ),
      FOREIGN_REFERENCE,
    );
    assertEquals(
      await f.evaluate(
        `data.query('ns == "security"', 'attributes.password')`,
        { secretBag: f.bag },
      ),
      [FOREIGN_REFERENCE],
    );
  });
});

Deno.test("typed data secrets: data.query predicates and projections refuse on a tagged field, absorbed or not, under a history term, by membership and by list equality, a null comparison matches, and the raw query keeps the stored reference text", async () => {
  await withFixture(async (f) => {
    const passwordKey = keyOf(f.modelId, "creds", "main", "password");
    const reference = `\${{ vault.get('prod', '${passwordKey}') }}`;
    // A record stored as JSON with a media type parameter: content aliases
    // its viewed attributes under the view, and stays text on the raw path.
    await f.store(
      "charset",
      { [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]) },
      JSON.stringify({ password: reference, user: "c" }),
      "application/json; charset=utf-8",
    );
    // Two the view answers as stored, untagged: their content keeps the
    // raw path's text, whether the body parses or not.
    const plainBody = JSON.stringify({ password: reference, user: "p" });
    await f.store(
      "charset-plain",
      {},
      plainBody,
      "application/json; charset=utf-8",
    );
    await f.store(
      "charset-broken",
      {},
      "not json",
      "application/json; charset=utf-8",
    );
    await f.sync();
    const asStored = [
      ["charset-plain", plainBody],
      ["charset-broken", "not json"],
    ];
    for (const [name, body] of asStored) {
      const predicate = `modelName == "db" && name == "${name}"`;
      assertEquals(
        await f.evaluate(`data.query('${predicate}', 'content')`),
        [body],
        name,
      );
      assertEquals(
        await f.dqs.query(predicate, { select: "content" }),
        [body],
        name,
      );
      assertEquals(
        await f.evaluate(
          `size(data.query('${predicate} && type(content) == string'))`,
        ),
        (await f.dqs.query(`${predicate} && type(content) == string`)).length,
        name,
      );
    }
    const charset = sentinelOf(
      f,
      await f.evaluate(
        `data.query('modelName == "db" && name == "charset"', 'content')[0].password`,
      ),
    );
    assertEquals(
      (await f.loader.load(f.bag, { charset })).resolveDeep({ charset }),
      { charset: f.secrets.password },
    );

    const refused = async (expression: string, operation: string) => {
      const error = await assertRejects(
        () => f.evaluate(expression),
        SecretRefusedError,
        undefined,
        expression,
      );
      assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED, expression);
      assertStringIncludes(error.operation, operation, expression);
    };
    const container =
      "a container comparison (in, or == or != with no scalar literal or " +
      "null operand) in a query ";
    for (
      const predicate of [
        `attributes.password == "x"`,
        `attributes.password == "x" || true`,
        `version >= 1 && attributes.password == "x"`,
        `attributes.nested.token == "x" || name == "main"`,
      ]
    ) {
      await refused(
        `data.query('modelName == "db" && ${predicate}')`,
        "Secret == string",
      );
    }
    for (
      const predicate of [
        `attributes.password in ["", "changeme"]`,
        `[attributes.password] == ["x"]`,
        `{"k": attributes.password} != {"k": "x"}`,
        // The rule decides before an unrelated error in the same row.
        `attributes.password in ["changeme"] || attributes.missing.k == "x"`,
      ]
    ) {
      await refused(
        `data.query('modelName == "db" && ${predicate}')`,
        container + "predicate that reads a secret",
      );
    }
    await refused(
      `data.query('modelName == "db" && name == "main"', 'attributes.password == "x"')`,
      "Secret == string",
    );
    await refused(
      `data.query('modelName == "db" && name == "main"', 'attributes.password in ["x"]')`,
      container + "projection that reads a secret",
    );
    await refused(
      `data.query('modelName == "db" && name == "main"', 'attributes.password in ["x"] ? 1 : attributes.missing.k')`,
      container + "projection that reads a secret",
    );

    // The allowed set holds in a predicate, and the calling expression's own
    // container comparison beside it is not refused by the predicate's reads.
    assertEquals(
      await f.evaluate(
        `data.query('modelName == "db" && name == "main" && attributes.password != null').map(r, r.name) == ["main"]`,
      ),
      true,
    );
    assertEquals(
      await f.evaluate(
        `size(data.query('modelName == "db" && name == "main" && attributes.password == null'))`,
      ),
      0,
    );
    // The one vault read is the load above; evaluation made none.
    assertEquals(f.counting.reads.map((read) => read.key), [passwordKey]);
    assertEquals(f.bag.rawValues, []);
    assertEquals(f.redacted, [f.secrets.password]);

    // The raw query service answers the stored reference text everywhere.
    const [raw] = await f.dqs.query(
      'modelName == "db" && name == "main"',
    ) as DataRecord[];
    assertEquals(raw.attributes.password, reference);
    assertEquals(
      await f.dqs.query('modelName == "db" && name == "main"', {
        select: "attributes.password",
      }),
      [reference],
    );
    assertEquals(
      (await f.dqs.query('modelName == "db" && name == "main"', {
        select: "content",
      }) as Record<string, unknown>[])[0].password,
      reference,
    );
    assertEquals(
      await f.dqs.query('modelName == "db" && name == "charset"', {
        select: "content",
      }),
      [JSON.stringify({ password: reference, user: "c" })],
    );
  });
});

Deno.test("typed data secrets: a record the writer could not have stored refuses with secret_reference_invalid and no value, and raw content is unchanged", async () => {
  await withFixture(async (f) => {
    await f.store("bad-tag", { [SENSITIVE_FIELDS_TAG]: "not json" }, '{"x":1}');
    await f.store(
      "bad-value",
      { [SENSITIVE_FIELDS_TAG]: JSON.stringify(["password"]) },
      JSON.stringify({ password: "plain-s3cret" }),
    );
    await f.store(
      "raw",
      { [SENSITIVE_FIELDS_TAG]: JSON.stringify(["x"]) },
      "raw ${{ vault.get('prod', 'A') }}",
      "text/plain",
    );
    await f.sync();
    for (
      const [name, reason] of [
        ["bad-tag", `The ${SENSITIVE_FIELDS_TAG} tag is invalid: not JSON`],
        ["bad-value", "field 'password' is not a stored vault reference"],
      ]
    ) {
      for (
        const expression of [
          `data.latest('db', '${name}').attributes`,
          `dyn(data.latest('db', '${name}')) == null || true`,
          `model.db.resource.creds['${name}'].attributes`,
          // A record the query answers, and a row its predicate reads.
          `data.query('modelName == "db" && name == "${name}"')`,
          `data.query('modelName == "db" && name == "${name}" && attributes.x != null')`,
          `data.query('modelName == "db" && name == "${name}" && (attributes.x != null || true)')`,
          `data.query('modelName == "db" && name == "${name}"', 'attributes.x')`,
        ]
      ) {
        const error = await assertRejects(
          () => f.evaluate(expression),
          SecretRefusedError,
          undefined,
          expression,
        );
        assertEquals(error.code, SECRET_REFERENCE_INVALID, expression);
        assertStringIncludes(error.operation, "model 'db' record ");
        assertStringIncludes(error.operation, reason);
        assertEquals(error.operation.includes(name), false, expression);
        assertEquals(error.message.includes("plain-s3cret"), false);
        if (expression.startsWith("data.query")) {
          assertStringIncludes(error.operation, "(data.query)");
        }
      }
    }
    assertEquals(
      await f.evaluate("data.latest('db', 'raw').content"),
      "raw ${{ vault.get('prod', 'A') }}",
    );
    assertEquals(f.counting.reads, []);
    assertEquals(f.bag.registry.isEmpty, true);
  });
});

Deno.test("typed data secrets: readResource keeps resolving plaintext with its schema fallback, and the option-off path is unchanged", async () => {
  await withFixture(async (f) => {
    const passwordKey = keyOf(f.modelId, "creds", "main", "password");
    // A record with no tag, as data written before the tag existed.
    await f.store(
      "legacy",
      {},
      JSON.stringify({
        password: `\${{ vault.get('prod', '${passwordKey}') }}`,
        user: "l",
        nested: { token: "t", plain: "p" },
      }),
    );
    await f.sync();
    const readResource = createResourceReader(
      f.dataRepo,
      TYPE,
      f.modelId,
      f.vaultService,
      undefined,
      resources,
    );
    assertEquals((await readResource("main"))?.password, f.secrets.password);
    assertEquals((await readResource("main"))?.nested, {
      token: f.secrets.token,
      plain: "p",
    });
    assertEquals((await readResource("legacy"))?.password, f.secrets.password);
    // Each trusted read loads the value: three reads so far.
    assertEquals(f.counting.readsOf(passwordKey), 3);

    const off = new CelEvaluator();
    const context = f.context as unknown as Record<string, unknown>;
    assertEquals(
      await off.evaluateAsync(
        "data.latest('db', 'main').attributes.password",
        context,
      ),
      f.secrets.password,
    );
    assertEquals(
      await off.evaluateAsync(
        "data.version('db', 'main', 1).attributes.password",
        context,
      ),
      `\${{ vault.get('prod', '${passwordKey}') }}`,
    );
    assertEquals(
      await off.evaluateAsync(
        "model.db.resource.creds.main.attributes.password",
        context,
      ),
      `\${{ vault.get('prod', '${passwordKey}') }}`,
    );
    assertEquals(f.counting.readsOf(passwordKey), 4);
    assertEquals(f.bag.registry.isEmpty, true);
  });
});
