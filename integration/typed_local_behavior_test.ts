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
import { ProvenanceMap } from "../src/domain/expressions/provenance_map.ts";
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
import { shellModel } from "../src/domain/models/command/shell/shell_model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { SENSITIVE_FORMAT_VERSION } from "../src/domain/secrets/persisted_sensitive_form.ts";
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
  runDeps: () => ModelMethodRunDeps;
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
            // A value of this delivery in hand: the bag issued a reference
            // of this definition and loaded it. resolvesAny is registry-wide,
            // and one validation run's definitions share a registry.
            loaded: (context.vaultSecrets?.rawValues.length ?? 0) > 0,
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

    const runDeps = (): ModelMethodRunDeps => ({
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
      saveEvaluatedDefinition: (
        t,
        def,
        provenance,
        authored,
        written,
        maskedPaths,
        persistedProvenance,
      ) =>
        evaluatedDefRepo.save(
          t,
          def,
          provenance,
          authored,
          undefined,
          written,
          maskedPaths,
          persistedProvenance,
        ),
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
      ...({}),
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

Deno.test("typed local behavior: evaluate writes a reference-safe cache with zero loads", async () => {
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
    assertEquals(cached.sensitiveFormat, SENSITIVE_FORMAT_VERSION);
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
        modelMethodRun(createLibSwampContext(), f.runDeps(), {
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
      modelMethodRun(createLibSwampContext(), f.runDeps(), {
        modelIdOrName: "svc-0",
        methodName: METHOD,
        inputs: {},
        lastEvaluated: false,
      }),
    );
    assertEquals(f.counting.readsOf(keyOf(0)) - before, 2);
    assertEquals(f.received.at(-1)!.args.password, f.canaries[0].value);
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: --last-evaluated replays the cache as references, reads nothing to restore, loads the current value once at delivery, and persists none (typed-secrets 4.4)", async () => {
  await withFixture(async (f) => {
    await f.save(Definition.create({
      name: "replay",
      type: f.type.normalized,
      globalArguments: {
        token: "${{ data.latest('db', 'main').attributes.password }}",
      },
      methods: {
        [METHOD]: {
          arguments: {
            password: "${{ vault.get('prod', 'canary-0') + '' }}",
            note: "${{ 'n-' + data.latest('db', 'main').attributes.password }}",
          },
        },
      },
    }));
    const replay = (lastEvaluated: boolean) =>
      collect<ModelMethodRunEvent>(
        modelMethodRun(createLibSwampContext(), f.runDeps(), {
          modelIdOrName: "replay",
          methodName: METHOD,
          inputs: {},
          lastEvaluated,
        }),
      );
    // A fresh typed run writes the cache: references, never values.
    const fresh = await replay(false);
    assertEquals(fresh.some((e) => e.kind === "error"), false);
    assertEquals(f.received.at(-1)!.args.note, `n-${f.stored.password}`);
    const cached = await f.evaluatedDefRepo.findByNameWithProvenance(
      f.type,
      "replay",
    );
    assert(cached);
    assertEquals((cached.writtenReferences ?? []).length, 2);
    assert(cached.persistedProvenance instanceof ProvenanceMap);

    // The vault rotates between the run and its replay.
    const vault = /vault\.get\('([^']+)'/.exec(f.stored.reference)![1];
    const rotated = `pw-rotated-${crypto.randomUUID()}`;
    await f.access(() => f.vaultService.put(vault, f.stored.key, rotated));
    f.forbidden.push(rotated);

    const storedBefore = f.counting.readsOf(f.stored.key);
    const canaryBefore = f.counting.readsOf(keyOf(0));
    const events = await replay(true);
    const error = events.find((e) => e.kind === "error");
    assertEquals(error, undefined, JSON.stringify(error));
    // The replay restored references and loaded the current value at
    // delivery: one load per data-origin reference (authorized, not probed),
    // a probe and a load for the runtime vault.get.
    const last = f.received.at(-1)!;
    assertEquals(last.args.note, `n-${rotated}`);
    assertEquals(last.globalArgs.token, rotated);
    assertEquals(last.args.password, f.canaries[0].value);
    assertEquals(f.counting.readsOf(f.stored.key) - storedBefore, 1);
    assertEquals(f.counting.readsOf(keyOf(0)) - canaryBefore, 2);
    assertStringIncludes(String(last.unresolved?.note), "__SWAMP_VSEC_");
    assertValueFree(f, JSON.stringify(events), "replay events");
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
    const callerRegistry = new SecretBagRegistry();
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
    const contextualDef = await f.save(Definition.create({
      name: "contextual",
      type: f.type.normalized,
      globalArguments: {
        token: "${{ vault.get(inputs.vaultName, 'canary-6') }}",
      },
      methods: {
        [METHOD]: { arguments: {} },
        other: { arguments: { note: "${{ vault.get('prod', 'canary-7') }}" } },
      },
    }));
    const defaultedDef = await f.save(Definition.create({
      name: "defaulted",
      type: f.type.normalized,
      inputs: {
        properties: { vaultName: { type: "string", default: "prod" } },
      },
      globalArguments: {
        token: "${{ vault.get(inputs.vaultName, 'canary-8') }}",
      },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const unsetVariable = `SWAMP_UNSET_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    const envlessDef = await f.save(Definition.create({
      name: "envless",
      type: f.type.normalized,
      globalArguments: { token: `\${{ env.${unsetVariable} }}` },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const missingDef = await f.save(Definition.create({
      name: "missing",
      type: f.type.normalized,
      globalArguments: { token: "${{ vault.get('prod', 'no-such-key') }}" },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const aliasedDef = await f.save(Definition.create({
      name: "aliased",
      type: f.type.normalized,
      globalArguments: { token: "${{ dyn(vault).get('prod', 'canary-9') }}" },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const deps = createModelValidateDeps(
      f.repoDir,
      { method: METHOD },
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
    const check = refused.results.find((r) =>
      r.name === "Check argument delivery"
    );
    assertEquals(check?.passed, false);
    assertStringIncludes(check?.error ?? "", "secret_destination_refused");
    assertStringIncludes(check?.error ?? "", "region");
    assertEquals(f.checked.length, checksBefore);
    // The existence probe ran at evaluation; the refusal made no load.
    assertEquals(f.counting.readsOf(keyOf(4)) - before4, 1);
    assertValueFree(f, JSON.stringify(refused), "the refusal");

    // What validate cannot evaluate, an input with no default, is left as
    // its stored text for the check; nothing
    // is read. Another method's expressions are outside this validation and
    // never evaluated.
    const before6 = f.counting.readsOf(keyOf(6));
    const before7 = f.counting.readsOf(keyOf(7));
    const contextual = await deps.validateModel(contextualDef, f.model, f.type);
    assertEquals(
      contextual.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(contextual.results),
    );
    assertEquals(
      f.checked.at(-1)!.globalArgs.token,
      "${{ vault.get(inputs.vaultName, 'canary-6') }}",
    );
    assertEquals(f.checked.at(-1)!.loaded, false);
    assertEquals(f.counting.readsOf(keyOf(6)) - before6, 0);
    assertEquals(f.counting.readsOf(keyOf(7)) - before7, 0);

    // An input with a default is bound as a run binds it, so the reference
    // resolves and the check sees the value.
    const before8 = f.counting.readsOf(keyOf(8));
    const defaulted = await deps.validateModel(defaultedDef, f.model, f.type);
    assertEquals(
      defaulted.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(defaulted.results),
    );
    assertEquals(f.checked.at(-1)!.globalArgs.token, f.canaries[8].value);
    assertEquals(f.counting.readsOf(keyOf(8)) - before8, 2);

    // An environment variable unset where validate runs degrades the same way.
    const envless = await deps.validateModel(envlessDef, f.model, f.type);
    assertEquals(
      envless.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
    );
    assertEquals(
      f.checked.at(-1)!.globalArgs.token,
      `\${{ env.${unsetVariable} }}`,
    );

    // A reference the run would fail to find fails the checks here too.
    const checksBeforeMissing = f.checked.length;
    const missing = await deps.validateModel(missingDef, f.model, f.type);
    const missingCheck = missing.results.find((r) =>
      r.name === "Check argument delivery"
    );
    assertEquals(missingCheck?.passed, false);
    assertStringIncludes(missingCheck?.error ?? "", "no-such-key");
    assertEquals(f.checked.length, checksBeforeMissing);
    assertValueFree(f, JSON.stringify(missing), "the missing-key failure");

    // A vault reached through an alias is refused as the run refuses it,
    // before any check runs and with no read.
    const before9 = f.counting.readsOf(keyOf(9));
    const aliased = await deps.validateModel(aliasedDef, f.model, f.type);
    const aliasedCheck = aliased.results.find((r) => r.name === "Secret usage");
    assertEquals(aliasedCheck?.passed, false);
    assertStringIncludes(aliasedCheck?.error ?? "", "directly");
    assertEquals(f.checked.length, checksBeforeMissing);
    assertEquals(f.counting.readsOf(keyOf(9)) - before9, 0);

    // What validate cannot evaluate degrades expression by expression, in
    // any key order: the unset variable's argument is left as its stored
    // text, while the reference beside it is still checked, refused or
    // delivered as the run would.
    const partialDef = await f.save(Definition.create({
      name: "partial",
      type: f.type.normalized,
      globalArguments: {
        region: `\${{ env.${unsetVariable} }}`,
        token: "${{ vault.get('prod', 'canary-5') }}",
      },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const before5 = f.counting.readsOf(keyOf(5));
    const partial = await deps.validateModel(partialDef, f.model, f.type);
    assertEquals(
      partial.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(partial.results),
    );
    assertEquals(f.checked.at(-1)!.globalArgs.token, f.canaries[5].value);
    assertEquals(
      f.checked.at(-1)!.globalArgs.region,
      `\${{ env.${unsetVariable} }}`,
    );
    assertEquals(f.checked.at(-1)!.loaded, true);
    assertEquals(f.counting.readsOf(keyOf(5)) - before5, 2);

    // A refused destination beside an unset variable is refused whichever
    // of the two is evaluated first.
    const checksBeforeOrdered = f.checked.length;
    const before10 = f.counting.readsOf(keyOf(10));
    const before11 = f.counting.readsOf(keyOf(11));
    for (
      const [name, globalArguments] of [
        ["unset-first", {
          token: `\${{ env.${unsetVariable} }}`,
          region: "${{ vault.get('prod', 'canary-10') }}",
        }],
        ["unset-last", {
          region: "${{ vault.get('prod', 'canary-11') }}",
          token: `\${{ env.${unsetVariable} }}`,
        }],
      ] as const
    ) {
      const ordered = await f.save(Definition.create({
        name,
        type: f.type.normalized,
        globalArguments,
        methods: { [METHOD]: { arguments: {} } },
      }));
      const outcome = await deps.validateModel(ordered, f.model, f.type);
      const orderedCheck = outcome.results.find((r) =>
        r.name === "Check argument delivery"
      );
      assertEquals(orderedCheck?.passed, false, name);
      assertStringIncludes(
        orderedCheck?.error ?? "",
        "secret_destination_refused",
        name,
      );
      assertStringIncludes(orderedCheck?.error ?? "", "region", name);
      assertValueFree(f, JSON.stringify(outcome), `the refusal (${name})`);
    }
    assertEquals(f.checked.length, checksBeforeOrdered);
    // Each probed once at evaluation, and refused before any load.
    assertEquals(f.counting.readsOf(keyOf(10)) - before10, 1);
    assertEquals(f.counting.readsOf(keyOf(11)) - before11, 1);

    // A missing key beside an unset variable fails the checks as the run
    // would fail.
    const unsetBesideMissing = await f.save(Definition.create({
      name: "unset-beside-missing",
      type: f.type.normalized,
      globalArguments: {
        region: `\${{ env.${unsetVariable} }}`,
        token: "${{ vault.get('prod', 'no-such-key-either') }}",
      },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const besideMissing = await deps.validateModel(
      unsetBesideMissing,
      f.model,
      f.type,
    );
    const besideMissingCheck = besideMissing.results.find((r) =>
      r.name === "Check argument delivery"
    );
    assertEquals(besideMissingCheck?.passed, false);
    assertStringIncludes(
      besideMissingCheck?.error ?? "",
      "no-such-key-either",
    );
    assertEquals(f.checked.length, checksBeforeOrdered);
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: a run resolves the global arguments and the invoked method's runtime expressions only, so another method's reference is neither checked, read nor failed on", async () => {
  await withFixture(async (f) => {
    await f.save(Definition.create({
      name: "two-methods",
      type: f.type.normalized,
      globalArguments: { token: "${{ vault.get('prod', 'token') }}" },
      methods: {
        [METHOD]: {
          arguments: { note: "${{ vault.get('prod', 'canary-5') }}" },
        },
        // A missing key, a readable key and an alias, none of them the
        // invoked method's: the run of `run` never needs them, as it never
        // needs another method's inputs.
        other: {
          arguments: {
            note: "${{ vault.get('prod', 'no-such-key') }}",
            password: "${{ vault.get('prod', 'canary-4') }}",
            extra: "${{ dyn(vault).get('prod', 'canary-3') }}",
          },
        },
      },
    }));
    {
      f.received.length = 0;
      const before4 = f.counting.readsOf(keyOf(4));
      const before5 = f.counting.readsOf(keyOf(5));
      const beforeMissing = f.counting.readsOf("no-such-key");
      const events = await collect<ModelMethodRunEvent>(
        modelMethodRun(createLibSwampContext(), f.runDeps(), {
          modelIdOrName: "two-methods",
          methodName: METHOD,
          inputs: {},
          lastEvaluated: false,
        }),
      );
      const error = events.find((e) => e.kind === "error");
      assertEquals(error, undefined, `${true}: ${JSON.stringify(error)}`);
      const last = f.received.at(-1)!;
      assertEquals(last.args.note, f.canaries[5].value, String(true));
      assertEquals(last.globalArgs.token, f.stored.token, String(true));
      assert(f.counting.readsOf(keyOf(5)) > before5, String(true));
      assertEquals(f.counting.readsOf(keyOf(4)) - before4, 0, String(true));
      assertEquals(
        f.counting.readsOf("no-such-key") - beforeMissing,
        0,
        String(true),
      );
    }
    await assertNoPlaintextOnDisk(f);
  });
});

Deno.test("typed local behavior: model.method inputs arrive at the trusted method as values, once per reference per attempt", async () => {
  await withFixture(async (f) => {
    const registry = new SecretBagRegistry();
    const bag = new VaultSecretBag(registry);
    const evaluator = new CelEvaluator();
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

Deno.test("default validation: tagged data reaches check delivery and only missing bindings stay unevaluated", async () => {
  await withFixture(async (f) => {
    const deps = createModelValidateDeps(
      f.repoDir,
      { method: METHOD },
      undefined,
      f.dataRepo,
      f.catalog,
      f.definitionRepo,
    );
    const stored = await f.save(Definition.create({
      name: "check-data",
      type: f.type.normalized,
      globalArguments: {
        token: "${{ data.latest('db', 'main').attributes.password }}",
      },
      methods: {
        [METHOD]: {
          arguments: {
            note: "${{ data.latest('db', 'main').attributes.password }}",
          },
        },
      },
    }));
    const before = f.counting.reads.length;
    const result = await deps.validateModel(stored, f.model, f.type);
    assertEquals(
      result.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(result),
    );
    assertStringIncludes(
      String(f.checked.at(-1)?.unresolved?.note),
      "__SWAMP_VSEC_",
    );
    assertEquals(f.checked.at(-1)?.loaded, true);
    assertEquals(f.counting.reads.length - before, 1);
    assertValueFree(f, JSON.stringify(result), "data validation");

    const executed = f.checked.length;
    for (
      const [index, expression] of [
        "env.PATH + 1",
        "env.PATH + missingRoot.field",
        "vault.get(123, 'canary-0')",
        "vault.get('prod', )",
      ].entries()
    ) {
      const invalid = await f.save(Definition.create({
        name: `invalid-check-${index}`,
        type: f.type.normalized,
        globalArguments: { token: "${{ " + expression + " }}" },
        methods: { [METHOD]: { arguments: {} } },
      }));
      const invalidResult = await deps.validateModel(invalid, f.model, f.type);
      assertEquals(
        invalidResult.results.some((r) => !r.passed),
        true,
        expression,
      );
      assertEquals(f.checked.length, executed, expression);
      assertValueFree(f, JSON.stringify(invalidResult), "invalid validation");
    }
  });
});

Deno.test("default validation: a global that reads a model with no data yet stays as its stored text and the checks still run", async () => {
  await withFixture(async (f) => {
    const deps = createModelValidateDeps(
      f.repoDir,
      { method: METHOD },
      undefined,
      f.dataRepo,
      f.catalog,
      f.definitionRepo,
    );
    // The upstream definition exists but has never run, so it has no
    // resource data: the gap a later run fills, not an invalid expression.
    await f.save(Definition.create({
      name: "upstream",
      type: f.type.normalized,
      globalArguments: {},
      methods: { [METHOD]: { arguments: {} } },
    }));
    const expression =
      "${{ model.upstream.resource.state.main.attributes.id }}";
    const downstream = await f.save(Definition.create({
      name: "downstream",
      type: f.type.normalized,
      globalArguments: { token: expression, region: "us-east-1" },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const checksBefore = f.checked.length;
    const result = await deps.validateModel(downstream, f.model, f.type);
    assertEquals(
      result.results.find((r) => r.name === "Check argument delivery"),
      undefined,
      JSON.stringify(result.results),
    );
    assertEquals(
      result.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(result.results),
    );
    assertEquals(f.checked.length, checksBefore + 1);
    assertEquals(f.checked.at(-1)!.globalArgs.token, expression);
    assertEquals(f.checked.at(-1)!.globalArgs.region, "us-east-1");

    // The recommended data.latest form of the same gap degrades the same
    // way: the lookup finds no record, and the select on it stays as text.
    const viaData = "${{ data.latest('upstream', 'main').attributes.id }}";
    const latest = await f.save(Definition.create({
      name: "downstream-latest",
      type: f.type.normalized,
      globalArguments: { token: viaData },
      methods: { [METHOD]: { arguments: {} } },
    }));
    const latestResult = await deps.validateModel(latest, f.model, f.type);
    assertEquals(
      latestResult.results.find((r) => r.name === "Check argument delivery"),
      undefined,
      JSON.stringify(latestResult.results),
    );
    assertEquals(
      latestResult.results.find((r) => r.name === "Check: see-args")?.passed,
      true,
      JSON.stringify(latestResult.results),
    );
    assertEquals(f.checked.length, checksBefore + 2);
    assertEquals(f.checked.at(-1)!.globalArgs.token, viaData);

    const lookup = "data.latest('upstream', 'main')";
    for (
      const [index, receiver] of [
        `[${lookup}][0]`,
        `{'record': ${lookup}}.record`,
        `(true ? ${lookup} : {})`,
        `{'0': {}, 0: ${lookup}}['0']`,
      ].entries()
    ) {
      const token = `\${{ ${receiver}.attributes.id }}`;
      const wrapped = await f.save(Definition.create({
        name: `downstream-wrapped-${index}`,
        type: f.type.normalized,
        globalArguments: { token },
        methods: { [METHOD]: { arguments: {} } },
      }));
      const wrappedResult = await deps.validateModel(wrapped, f.model, f.type);
      assertEquals(
        wrappedResult.results.find((r) => r.name === "Check argument delivery"),
        undefined,
        JSON.stringify(wrappedResult.results),
      );
      assertEquals(f.checked.length, checksBefore + 3 + index);
      assertEquals(f.checked.at(-1)!.globalArgs.token, token);
    }

    // The gap is the select on the lookup itself. A miss elsewhere in the
    // expression does not excuse an invalid select on something else, which
    // fails the checks whether or not the unrelated record exists.
    for (
      const [index, receiver] of [
        `[${lookup}, {}][1]`,
        `{'key': ${lookup}, 'key': {} }.key`,
        `{'0': ${lookup}, 0: {} }['0']`,
      ].entries()
    ) {
      const unrelated = await f.save(Definition.create({
        name: `downstream-unrelated-miss-${index}`,
        type: f.type.normalized,
        globalArguments: { token: `\${{ ${receiver}.attributes }}` },
        methods: { [METHOD]: { arguments: {} } },
      }));
      const unrelatedResult = await deps.validateModel(
        unrelated,
        f.model,
        f.type,
      );
      assertEquals(
        unrelatedResult.results.some((r) => !r.passed),
        true,
        JSON.stringify(unrelatedResult.results),
      );
      assertEquals(f.checked.length, checksBefore + 6);
    }
  });
});

Deno.test({
  name:
    "typed local behavior: legacy evaluate then replay caches retain data origin and refuse a quoted heredoc",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixture(async (f) => {
      const reference = f.stored.reference;
      const command = `cat <<'EOF'\n${reference}\nEOF`;
      const definition = Definition.create({
        name: "legacy-heredoc",
        methods: { execute: { arguments: { run: command } } },
      });
      const path = "methods.execute.arguments.run";
      const start = command.indexOf(reference);
      const provenance = ProvenanceMap.authored().withRanges(path, [[
        start,
        start + f.stored.password.length,
      ]]);
      const persistedProvenance = ProvenanceMap.authored().withRanges(path, [[
        start,
        start + reference.length,
      ]]);
      await f.definitionRepo.save(shellModel.type, definition);
      await f.evaluatedDefRepo.save(
        shellModel.type,
        definition,
        provenance,
        new Set(["${{ data.latest('db', 'main').attributes.password }}"]),
        [],
        [{
          path: ["methods", "execute", "arguments", "run"],
          occurrence: 0,
          vaultName: VAULT,
          key: f.stored.key,
          encoding: "raw",
          dataOrigin: false,
        }],
        [],
        persistedProvenance,
      );
      const cachePath = f.evaluatedDefRepo.getPath(
        shellModel.type,
        definition.id,
      );
      const text = await Deno.readTextFile(cachePath);
      await Deno.writeTextFile(
        cachePath,
        text.replace(
          `sensitiveFormat: ${SENSITIVE_FORMAT_VERSION}`,
          "sensitiveFormat: 2",
        ),
      );
      const deps: ModelMethodRunDeps = {
        ...f.runDeps(),
        lookupDefinition: () =>
          Promise.resolve({ definition, type: shellModel.type }),
        getModelDef: () => ({
          ...shellModel,
          methods: {
            execute: {
              ...shellModel.methods.execute,
              execute: () => {
                throw new Error("A refused command must never execute");
              },
            },
          },
        }),
      };
      const events = await f.access(() =>
        collect(modelMethodRun(createLibSwampContext(), deps, {
          modelIdOrName: definition.name,
          methodName: "execute",
          inputs: {},
          lastEvaluated: true,
        }))
      );
      const errors = events.filter((event) => event.kind === "error");
      assertEquals(errors.length, 1);
      assertEquals(errors[0].error.code, "secret_destination_refused");
      assertStringIncludes(
        errors[0].error.message,
        "here-document with a quoted delimiter",
      );
      assertEquals(events.some((event) => event.kind === "completed"), false);
      assertEquals(f.counting.reads, []);
      await assertNoPlaintextOnDisk(f);
    });
  },
});
