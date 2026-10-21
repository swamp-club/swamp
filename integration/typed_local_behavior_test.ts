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
 * Typed secrets on the local behavior path, end to end
 * (design/enablers/typed-secrets.md Section 11, Phase 3.5), through real
 * components in process: the libswamp entry points `swamp behavior evaluate`,
 * `swamp behavior validate` and `swamp behavior run`, `context.runModel` and
 * `model.method`, wired to real repositories on a temp repository and a
 * counting vault serving every canary class. The internal option is turned on
 * through the entry points' sensitive-values factories, as only tests may.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ExpressionEvaluationService } from "../src/domain/expressions/expression_evaluation_service.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import { buildMethodContext } from "../src/domain/models/method_context.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import {
  defineModel,
  type MethodContext,
  type ModelDefinition,
} from "../src/domain/models/model.ts";
import { ModelInvocationService } from "../src/domain/models/model_invocation_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import {
  createVaultConfigId,
  VaultConfig,
} from "../src/domain/vaults/vault_config.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  CelEvaluator,
  createExtensionCelEnvironment,
  type EvaluationScope,
} from "../src/infrastructure/cel/cel_evaluator.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelEvaluateDeps,
  modelEvaluate,
  type ModelEvaluateEvent,
} from "../src/libswamp/models/evaluate.ts";
import {
  modelMethodRun,
  type ModelMethodRunDeps,
  type ModelMethodRunEvent,
} from "../src/libswamp/models/run.ts";
import { createModelValidateDeps } from "../src/libswamp/models/validate.ts";
import { collect } from "../src/libswamp/testing.ts";
import { generateCanaries, registerCountingVault } from "./canary_values.ts";

await initializeLogging({});

const VAULT = "prod";
const METHOD = "run";
const keyOf = (i: number) => `canary-${i}`;

/** What the trusted method and check received, in order. */
interface Received {
  args: Record<string, unknown>;
  globalArgs: Record<string, unknown>;
  unresolved: Record<string, unknown> | undefined;
}
interface Checked extends Received {
  loaded: boolean;
}

interface Fixture {
  repoDir: string;
  type: ModelType;
  model: ModelDefinition;
  canaries: ReturnType<typeof generateCanaries>;
  counting: ReturnType<typeof registerCountingVault>;
  vaultService: VaultService;
  redactor: SecretRedactor;
  dataRepo: FileSystemUnifiedDataRepository;
  catalog: CatalogStore;
  dqs: DataQueryService;
  definitionRepo: YamlDefinitionRepository;
  evaluatedDefRepo: YamlEvaluatedDefinitionRepository;
  outputRepo: YamlOutputRepository;
  evaluationService: ExpressionEvaluationService;
  /** The tagged record's stored password reference text and its vault key, and a plain vault secret. */
  stored: { reference: string; key: string; password: string; token: string };
  received: Received[];
  checked: Checked[];
  typedValues: () => RunSensitiveValues;
  runDeps: (typed: boolean) => ModelMethodRunDeps;
  save: (definition: Definition) => Promise<Definition>;
  access: <T>(fn: () => Promise<T>, vaults?: string[]) => Promise<T>;
  /** Every unique canary value, the password and the token: nothing on disk may hold one. */
  forbidden: string[];
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const canaries = generateCanaries();
  const password = `pw-${crypto.randomUUID()}`;
  const token = `tk-${crypto.randomUUID()}`;
  const counting = registerCountingVault({
    ...Object.fromEntries(canaries.map((c, i) => [keyOf(i), c.value])),
    token,
  });
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3628-" });
  const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
  const received: Received[] = [];
  const checked: Checked[] = [];
  const type = ModelType.create(
    `test/typed-local-${crypto.randomUUID().slice(0, 8)}`,
  );
  const model: ModelDefinition = defineModel({
    type,
    version: "2026.10.21.1",
    globalArguments: z.object({
      token: z.string().optional(),
      region: z.string().optional().meta({ secrets: "refuse" }),
    }),
    resources: {
      creds: {
        schema: z.object({
          password: z.string().meta({ sensitive: true }),
          host: z.string(),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      [METHOD]: {
        description: "records what it received",
        arguments: z.object({
          password: z.string().optional(),
          note: z.string().optional(),
        }),
        execute: (args, context) => {
          received.push({
            args: { ...(args as Record<string, unknown>) },
            globalArgs: { ...context.globalArgs },
            unresolved: context.unresolvedMethodArgs,
          });
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
    checks: {
      "see-args": {
        description: "records what the check received",
        execute: (context) => {
          checked.push({
            args: {},
            globalArgs: { ...context.globalArgs },
            unresolved: context.unresolvedMethodArgs,
            loaded: context.vaultSecrets?.resolvesAny === true,
          });
          return Promise.resolve({ pass: true });
        },
      },
    },
  });
  try {
    await ensureDir(join(repoDir, ".swamp", "data"));
    await ensureDir(join(repoDir, "models"));
    const vaultService = new VaultService();
    vaultService.registerVault({
      name: VAULT,
      type: counting.type,
      config: {},
    });
    // The same vault as a repository config, for the entry points that build
    // their own vault service from the repository.
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(
        createVaultConfigId(crypto.randomUUID()),
        VAULT,
        counting.type,
        {},
      ),
    );
    const redactor = new SecretRedactor();
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
      undefined,
      undefined,
      SOLO_NAMESPACE,
      undefined,
      undefined,
      () => Promise.resolve(null),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    const outputRepo = new YamlOutputRepository(repoDir);
    const evaluationService = new ExpressionEvaluationService(
      definitionRepo,
      repoDir,
      { vaultService, dataRepo, dataQueryService: dqs },
    );

    // A model whose resource holds a tagged field, written through the real
    // writer so the record carries the stored reference.
    const db = Definition.create({ name: "db", type: type.normalized });
    await definitionRepo.save(type, db);
    await createResourceWriter(
      dataRepo,
      type,
      db.id,
      model.resources!,
      undefined,
      undefined,
      undefined,
      undefined,
      "db",
      vaultService,
      METHOD,
    ).writeResource("creds", "main", { password, host: "h" });
    await dqs.query('name == ""');
    const storedData = await dataRepo.findByName(type, db.id, "main");
    const storedContent = JSON.parse(
      new TextDecoder().decode(
        (await dataRepo.getContent(type, db.id, "main"))!,
      ),
    ) as { password: string };
    assert(storedData);
    const reference = storedContent.password;
    const key = /vault\.get\('[^']+', '([^']+)'\)/.exec(reference)![1];

    const typedValues = () =>
      new RunSensitiveValues(
        redactor,
        new SecretBagRegistry({ typedSecrets: true }),
      );
    const runDeps = (typed: boolean): ModelMethodRunDeps => ({
      repoDir,
      lookupDefinition: (idOrName) =>
        definitionRepo.findByNameGlobal(idOrName).then((found) =>
          found && found.type.normalized === type.normalized
            ? { definition: found.definition, type }
            : null
        ),
      getModelDef: () => model,
      createEvaluationService: () => evaluationService,
      loadEvaluatedDefinition: (t, name) =>
        evaluatedDefRepo.findByNameWithProvenance(t, name),
      saveEvaluatedDefinition: (t, def, provenance, authored, written) =>
        evaluatedDefRepo.save(t, def, provenance, authored, undefined, written),
      createExecutionService: () => new DefaultMethodExecutionService(),
      createVaultService: () => Promise.resolve(vaultService),
      dataRepo,
      catalogStore: catalog,
      definitionRepo,
      outputRepo,
      dataQueryService: dqs,
      createRunLog: () =>
        Promise.resolve({
          logFilePath: join(repoDir, "run.log"),
          redactor,
          cleanup: () => {},
        }),
      ...(typed
        ? {
          createSensitiveValues: (r: SecretRedactor) =>
            new RunSensitiveValues(
              r,
              new SecretBagRegistry({ typedSecrets: true }),
            ),
        }
        : {}),
    });
    const fixture: Fixture = {
      repoDir,
      type,
      model,
      canaries,
      counting,
      vaultService,
      redactor,
      dataRepo,
      catalog,
      dqs,
      definitionRepo,
      evaluatedDefRepo,
      outputRepo,
      evaluationService,
      stored: { reference, key, password, token },
      received,
      checked,
      typedValues,
      runDeps,
      save: async (definition) => {
        await definitionRepo.save(type, definition);
        return definition;
      },
      access: (fn, vaults = [VAULT]) =>
        runWithVaultAccess(
          RunVaultAccess.create({ allowedVaults: vaults }),
          fn,
        ),
      forbidden: [
        ...canaries.filter((c) => c.unique).map((c) => c.value),
        password,
        token,
      ],
    };
    await fn(fixture);
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

/** Fails when any file under the repository holds a forbidden value or a sentinel. */
async function assertNoPlaintextOnDisk(f: Fixture): Promise<void> {
  for await (const entry of walk(f.repoDir, { includeDirs: false })) {
    if (entry.path.endsWith(".db") || entry.path.includes("_catalog")) continue;
    const text = await Deno.readTextFile(entry.path).catch(() => "");
    for (const value of f.forbidden) {
      assertEquals(
        text.includes(value),
        false,
        `${entry.path} holds a secret value`,
      );
    }
    assertEquals(
      text.includes("__SWAMP_VSEC_"),
      false,
      `${entry.path} holds a sentinel`,
    );
  }
}

function assertValueFree(f: Fixture, text: string, what: string): void {
  for (const value of f.forbidden) {
    assertEquals(text.includes(value), false, `${what} holds a secret value`);
  }
}

Deno.test("typed local behavior: evaluate writes a reference-safe cache with zero loads, and the untyped cache holds the same references", async () => {
  await withFixture(async (f) => {
    const app = await f.save(Definition.create({
      name: "app",
      type: f.type.normalized,
      globalArguments: {
        token: "${{ data.latest('db', 'main').attributes.password }}",
        host: "${{ data.latest('db', 'main').attributes.host }}",
        composed: "${{ 'x-' + data.latest('db', 'main').attributes.password }}",
        ref: "${{ vault.get('prod', 'canary-0') }}",
      },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const deps = createModelEvaluateDeps(
      f.repoDir,
      undefined,
      f.dataRepo,
      f.catalog,
      f.definitionRepo,
      undefined,
      undefined,
      f.typedValues,
    );
    const events = await collect<ModelEvaluateEvent>(
      modelEvaluate(createLibSwampContext(), deps, { modelIdOrName: "app" }),
    );
    assertEquals(events.some((e) => e.kind === "error"), false);
    assertValueFree(f, JSON.stringify(events), "evaluate events");
    // Evaluation alone makes no delivery load, and no probe either: the
    // data-origin reference is authorized, not checked, and vault.get stays
    // deferred.
    assertEquals(f.counting.reads.length, 0);

    const cached = await f.evaluatedDefRepo.findByNameWithProvenance(
      f.type,
      "app",
    );
    assert(cached);
    const args = cached.definition.globalArguments;
    assertEquals(args.token, f.stored.reference);
    assertEquals(args.composed, `x-${f.stored.reference}`);
    assertEquals(args.host, "h");
    assertEquals(args.ref, "${{ vault.get('prod', 'canary-0') }}");
    assertEquals(cached.sensitiveFormat, 1);
    const written = cached.writtenReferences ?? [];
    assertEquals(
      written.map((w) => [w.path.join("."), w.occurrence, w.key, w.dataOrigin]),
      [
        ["globalArguments.token", 0, f.stored.key, true],
        ["globalArguments.composed", 0, f.stored.key, true],
      ],
    );
    assertValueFree(
      f,
      await Deno.readTextFile(f.evaluatedDefRepo.getPath(f.type, app.id)),
      "the evaluated cache",
    );
    await assertNoPlaintextOnDisk(f);

    // The untyped path reads the value eagerly and writes the same cache.
    const untyped = createModelEvaluateDeps(
      f.repoDir,
      undefined,
      f.dataRepo,
      f.catalog,
      f.definitionRepo,
    );
    await collect<ModelEvaluateEvent>(
      modelEvaluate(createLibSwampContext(), untyped, {
        modelIdOrName: "app",
      }),
    );
    const plain = await f.evaluatedDefRepo.findByNameWithProvenance(
      f.type,
      "app",
    );
    assertEquals(plain?.definition.globalArguments, args);
    assert(f.counting.reads.length > 0);
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: run delivers the exact value of every canary class once per reference per attempt, and persists none", async () => {
  await withFixture(async (f) => {
    for (const [i, canary] of f.canaries.entries()) {
      const name = `svc-${i}`;
      await f.save(Definition.create({
        name,
        type: f.type.normalized,
        // The canary travels in a method argument; the global argument holds
        // a plain secret, since the globalArgs proxy refuses any delivered
        // value shaped like an expression, whatever the option.
        globalArguments: { token: "${{ vault.get('prod', 'token') }}" },
        methods: {
          [METHOD]: {
            arguments: {
              password: `\${{ vault.get('prod', '${keyOf(i)}') + '' }}`,
              note: "${{ data.latest('db', 'main').attributes.password }}",
            },
          },
        },
      }));
      const before = f.counting.readsOf(keyOf(i));
      const events = await collect<ModelMethodRunEvent>(
        modelMethodRun(createLibSwampContext(), f.runDeps(true), {
          modelIdOrName: name,
          methodName: METHOD,
          inputs: {},
          lastEvaluated: false,
        }),
      );
      const error = events.find((e) => e.kind === "error");
      assertEquals(error, undefined, JSON.stringify(error));
      const last = f.received.at(-1)!;
      assertEquals(last.args.password, canary.value, canary.class);
      assertEquals(last.args.note, f.stored.password, canary.class);
      assertEquals(last.globalArgs.token, f.stored.token, canary.class);
      // The method's merge keeps the sentinels, as the checks see them.
      assertStringIncludes(String(last.unresolved?.password), "__SWAMP_VSEC_");
      // One probe for the reference, then one load for the attempt.
      assertEquals(f.counting.readsOf(keyOf(i)) - before, 2, canary.class);
      assertValueFree(
        f,
        JSON.stringify(events),
        `run events (${canary.class})`,
      );
    }
    // A second attempt of the same definition is a new run: it probes and
    // loads again.
    const before = f.counting.readsOf(keyOf(0));
    await collect<ModelMethodRunEvent>(
      modelMethodRun(createLibSwampContext(), f.runDeps(true), {
        modelIdOrName: "svc-0",
        methodName: METHOD,
        inputs: {},
        lastEvaluated: false,
      }),
    );
    assertEquals(f.counting.readsOf(keyOf(0)) - before, 2);
    assertEquals(f.received.at(-1)!.args.password, f.canaries[0].value);
    await assertNoPlaintextOnDisk(f);

    // The untyped path delivers the same values.
    f.received.length = 0;
    await collect<ModelMethodRunEvent>(
      modelMethodRun(createLibSwampContext(), f.runDeps(false), {
        modelIdOrName: "svc-1",
        methodName: METHOD,
        inputs: {},
        lastEvaluated: false,
      }),
    );
    assertEquals(f.received.at(-1)!.args.password, f.canaries[1].value);
    assertEquals(f.received.at(-1)!.args.note, f.stored.password);
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: context.runModel rechecks under its own registry, loads once per attempt, and refuses revoked access before any load", async () => {
  await withFixture(async (f) => {
    await f.save(Definition.create({
      name: "nested",
      type: f.type.normalized,
      methods: {
        [METHOD]: {
          arguments: { password: "${{ vault.get('prod', 'canary-1') }}" },
        },
      },
    }));
    const service = new ModelInvocationService({
      executionService: new DefaultMethodExecutionService(),
      commonDeps: {
        dataRepository: f.dataRepo,
        definitionRepository: f.definitionRepo,
        outputRepository: f.outputRepo,
        vaultService: f.vaultService,
        redactor: f.redactor,
        dataQueryService: f.dqs,
        createCelEnvironment: createExtensionCelEnvironment,
      },
      evaluationService: f.evaluationService,
      repoDir: f.repoDir,
    });
    const callerRegistry = new SecretBagRegistry({ typedSecrets: true });
    const callerBag = new VaultSecretBag(callerRegistry);
    const callerSentinel = callerBag.addSecret(
      { vaultName: VAULT, key: keyOf(0) },
      "methods.run.arguments.x",
    );
    const caller: MethodContext = {
      signal: new AbortController().signal,
      repoDir: f.repoDir,
      modelType: f.type,
      modelId: "caller",
      globalArgs: {},
      definition: { id: "caller", name: "caller", version: 1, tags: {} },
      methodName: METHOD,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as unknown as MethodContext["logger"],
      dataRepository: f.dataRepo,
      definitionRepository: f.definitionRepo,
      redactor: f.redactor,
      vaultSecrets: callerBag,
      extensionFile: () => "",
      createCelEnvironment: createExtensionCelEnvironment,
    };
    const invoke = () =>
      service.invoke({ definition: "nested", method: METHOD }, caller);

    const before = f.counting.readsOf(keyOf(1));
    const first = await f.access(invoke);
    assertEquals(first.ok, true, JSON.stringify(first));
    assertEquals(f.received.at(-1)!.args.password, f.canaries[1].value);
    assertEquals(f.counting.readsOf(keyOf(1)) - before, 2);
    // A retry is a new attempt on a new independent registry: it checks the
    // reference anew and loads again.
    const second = await f.access(invoke);
    assertEquals(second.ok, true);
    assertEquals(f.counting.readsOf(keyOf(1)) - before, 4);
    // The caller's registry shared nothing with the nested runs.
    assertEquals([...callerRegistry.all()].length, 1);
    assertEquals(callerRegistry.entryOf(callerSentinel) !== undefined, true);
    // Revoked access fails the nested check before any load.
    const refused = await f.access(invoke, ["other-vault"]);
    assertEquals(refused.ok, false);
    assertEquals(f.counting.readsOf(keyOf(1)) - before, 4);
    assertValueFree(f, JSON.stringify(refused), "the refusal");
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: validate reports value-free diagnostics, delivers check arguments through the shared step, and a refusing destination makes no load", async () => {
  await withFixture(async (f) => {
    const diag = await f.save(Definition.create({
      name: "diag",
      type: f.type.normalized,
      globalArguments: { token: "${{ vault.get('prod', 'canary-2') == 'x' }}" },
    }));
    const checkedDef = await f.save(Definition.create({
      name: "checked",
      type: f.type.normalized,
      globalArguments: { token: "${{ vault.get('prod', 'canary-2') }}" },
      methods: {
        [METHOD]: {
          arguments: { note: "${{ vault.get('prod', 'canary-3') }}" },
        },
      },
    }));
    const refusedDef = await f.save(Definition.create({
      name: "refused",
      type: f.type.normalized,
      globalArguments: { region: "${{ vault.get('prod', 'canary-4') }}" },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const deps = createModelValidateDeps(
      f.repoDir,
      { method: METHOD, createSensitiveValues: f.typedValues },
      undefined,
      f.dataRepo,
      f.catalog,
      f.definitionRepo,
    );

    // One deps is one validation run: its registry answers each existence
    // check once, so the probe of canary-2 below is paid here.
    const before2 = f.counting.readsOf(keyOf(2));
    const diagnosed = await deps.validateModel(diag, f.model, f.type);
    const usage = diagnosed.results.find((r) => r.name === "Secret usage");
    assertEquals(usage?.passed, false);
    assertStringIncludes(usage?.error ?? "", "secret_operation_unsupported");
    assertStringIncludes(usage?.error ?? "", "Secret == string");
    assertStringIncludes(
      usage?.error ?? "",
      f.definitionRepo.getPath(f.type, diag.id),
    );
    assertStringIncludes(usage?.error ?? "", "globalArguments.token:1:1");
    assertValueFree(f, JSON.stringify(diagnosed), "the diagnostics");

    const before3 = f.counting.readsOf(keyOf(3));
    const delivered = await deps.validateModel(checkedDef, f.model, f.type);
    assertEquals(
      delivered.results.find((r) => r.name === "Secret usage")?.passed,
      true,
    );
    assertEquals(
      delivered.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(delivered.results),
    );
    const seen = f.checked.at(-1)!;
    assertEquals(seen.globalArgs.token, f.canaries[2].value);
    assertStringIncludes(String(seen.unresolved?.token), "__SWAMP_VSEC_");
    assertStringIncludes(String(seen.unresolved?.note), "__SWAMP_VSEC_");
    assertEquals(seen.loaded, true);
    // One probe and one load per reference: canary-2's probe was paid by the
    // diagnostics definition, whose misuse was refused before any load.
    assertEquals(f.counting.readsOf(keyOf(2)) - before2, 2);
    assertEquals(f.counting.readsOf(keyOf(3)) - before3, 2);

    const checksBefore = f.checked.length;
    const before4 = f.counting.readsOf(keyOf(4));
    const refused = await deps.validateModel(refusedDef, f.model, f.type);
    const check = refused.results.find((r) => r.name === "Check: see-args");
    assertEquals(check?.passed, false);
    assertStringIncludes(check?.error ?? "", "secret_destination_refused");
    assertStringIncludes(check?.error ?? "", "region");
    assertEquals(f.checked.length, checksBefore);
    // The existence probe ran at evaluation; the refusal made no load.
    assertEquals(f.counting.readsOf(keyOf(4)) - before4, 1);
    assertValueFree(f, JSON.stringify(refused), "the refusal");
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: model.method inputs arrive at the trusted method as values, once per reference per attempt", async () => {
  await withFixture(async (f) => {
    const registry = new SecretBagRegistry({ typedSecrets: true });
    const bag = new VaultSecretBag(registry);
    const evaluator = new CelEvaluator({ typedSecrets: true });
    const execution = new DefaultMethodExecutionService();
    const scope: EvaluationScope = {
      secretBag: bag,
      vault: {
        service: f.vaultService,
        redactor: f.redactor,
        location: "guard",
      },
    };
    const deliveredInputs: unknown[] = [];
    const context = {
      modelMethod: {
        method: async (
          _modelName: string,
          methodName: string,
          inputs: Record<string, unknown>,
        ) => {
          deliveredInputs.push(inputs);
          const def = Definition.create({
            name: "mm",
            type: f.type.normalized,
            methods: { [methodName]: { arguments: inputs } },
          });
          await execution.executeWorkflow(
            def,
            f.model,
            methodName,
            buildMethodContext({
              dataRepository: f.dataRepo,
              definitionRepository: f.definitionRepo,
              outputRepository: f.outputRepo,
              vaultService: f.vaultService,
              redactor: f.redactor,
              dataQueryService: f.dqs,
              createCelEnvironment: createExtensionCelEnvironment,
            }, {
              signal: new AbortController().signal,
              repoDir: f.repoDir,
              modelType: f.type,
              modelId: def.id,
              globalArgs: {},
              definition: {
                id: def.id,
                name: def.name,
                version: def.version,
                tags: {},
              },
              methodName,
              logger: {
                debug() {},
                info() {},
                warn() {},
                error() {},
              } as unknown as MethodContext["logger"],
              // The synthetic step's bag: a view of the run's registry.
              vaultSecrets: new VaultSecretBag(registry),
            }),
            { secretLoader: f.evaluationService.secretLoader(f.redactor) },
          );
          return null;
        },
      },
    };
    const before = f.counting.readsOf(keyOf(5));
    const result = await f.access(() =>
      evaluator.evaluateAsync(
        "model.method('mm', 'run', {'password': vault.get('prod', 'canary-5')}) == null",
        context,
        scope,
      )
    );
    assertEquals(result, true);
    // The delegate saw a sentinel, never the value; the method saw the value.
    assertStringIncludes(
      String((deliveredInputs[0] as Record<string, unknown>).password),
      "__SWAMP_VSEC_",
    );
    assertEquals(f.received.at(-1)!.args.password, f.canaries[5].value);
    assertEquals(f.counting.readsOf(keyOf(5)) - before, 2);
    await assertNoPlaintextOnDisk(f);
  });
});
