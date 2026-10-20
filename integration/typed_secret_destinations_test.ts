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
 * Typed secret destinations end to end (design/enablers/typed-secrets.md
 * Sections 6.3, 7.1 and 7.2, typed-secrets 3.4), through real components in
 * process: a typed run's registry and bag, a SecretLoader over a counting
 * vault, the method execution service, a recorder behavior and the built-in
 * command/shell behavior. Refusing destinations are refused before any read,
 * check or method; every canary class reaches each allowed boundary exactly;
 * the shell's own argv holds no plaintext; a NUL fails before any launch; a
 * failed method leaves a redacted output record; and a stand-in derives from a
 * typed evaluation with no load. The option-off path is pinned beside it.
 *
 * The shell cases run the host shell, as the canary boundary suite does:
 * `withMockedCommand` cannot stand in for `Deno.Command.spawn`. They are
 * POSIX-only, and the argv read is Linux-only (`/proc/<pid>/cmdline`, the
 * observation the sink inventory names for direct-shell-argv).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  CelEvaluator,
  createExtensionCelEnvironment,
  type EvaluationScope,
} from "../src/infrastructure/cel/cel_evaluator.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type {
  MethodContext,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import type { MethodExecutionEvent } from "../src/domain/models/method_events.ts";
import type { ModelOutput } from "../src/domain/models/model_output.ts";
import type { OutputRepository } from "../src/domain/models/repositories.ts";
import {
  SHELL_ENVIRONMENT_VALUE_REFUSED,
  SHELL_MODEL_TYPE,
  shellModel,
} from "../src/domain/models/command/shell/shell_model.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import {
  RunSensitiveValues,
  SecretRedactor,
} from "../src/domain/secrets/mod.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import { SecretDestinationRefusedError } from "../src/domain/models/secret_destinations.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import {
  type Canary,
  classifyValue,
  type CountingVault,
  generateCanaries,
  registerCountingVault,
  type ValueKind,
} from "./canary_values.ts";

await initializeLogging({});

const VAULT = "canary";
const posix = { ignore: Deno.build.os === "windows" };
const DATA_REF = { vaultName: VAULT, key: "stored" };

/** The key canary `i` is stored under. */
const keyOf = (i: number) => `k${i}`;

/**
 * Canary classes not passed as global arguments: a resolved global that
 * reads as expression syntax is excluded from the merge rather than
 * delivered (see the canary boundary suite).
 */
const NOT_GLOBAL = new Set(["reference-shaped"]);

interface Fixture {
  repoDir: string;
  canaries: Canary[];
  vault: CountingVault;
  vaultService: VaultService;
  registry: SecretBagRegistry;
  bag: VaultSecretBag;
  redactor: SecretRedactor;
  sensitiveValues: RunSensitiveValues;
  evaluator: CelEvaluator;
  scope: EvaluationScope;
  loader: SecretLoader;
  service: DefaultMethodExecutionService;
  dataRepo: FileSystemUnifiedDataRepository;
  /** Every output record a method boundary saved. */
  outputs: ModelOutput[];
  /** Every method event a step emitted. */
  events: MethodExecutionEvent[];
  /** A context for one delivery of `definition`. */
  context: (
    modelType: ModelType,
    definition: Definition,
    methodName: string,
    overrides?: Partial<MethodContext>,
  ) => MethodContext;
  /** Runs `fn` under the run's vault access. */
  access: <T>(fn: () => Promise<T>) => Promise<T>;
  /** A vault.get() reference to canary `i`, issued into the run. */
  ref: (i: number) => string;
  /** A data-origin reference, as the accessor adapter issues one. */
  dataRef: () => string;
}

/**
 * One run. `typed` sets the two switches of the internal option together,
 * the CelEvaluator option and the registry flag, so they never diverge.
 */
async function withFixture(
  typed: boolean,
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const canaries = generateCanaries();
  const vault = registerCountingVault({
    ...Object.fromEntries(canaries.map((c, i) => [keyOf(i), c.value])),
    stored: `stored-${crypto.randomUUID()}`,
    nul: "nul\u0000inside",
  });
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3627-" });
  const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    await ensureDir(join(repoDir, ".swamp", "data"));
    await ensureDir(join(repoDir, "models"));
    const vaultService = new VaultService();
    vaultService.registerVault({ name: VAULT, type: vault.type, config: {} });
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
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const redactor = new SecretRedactor();
    const registry = new SecretBagRegistry({ typedSecrets: typed });
    const sensitiveValues = new RunSensitiveValues(redactor, registry);
    const bag = new VaultSecretBag(registry);
    const evaluator = new CelEvaluator({ typedSecrets: typed });
    const scope: EvaluationScope = {
      secretBag: bag,
      vault: { service: vaultService, redactor, location: "inputs.secret" },
    };
    const loader = new SecretLoader(
      () => Promise.resolve(vaultService),
      redactor,
    );
    const outputs: ModelOutput[] = [];
    const outputRepository = {
      save: (_type: ModelType, _method: string, output: ModelOutput) => {
        outputs.push(output);
        return Promise.resolve();
      },
    } as unknown as OutputRepository;
    const events: MethodExecutionEvent[] = [];
    const fixture: Fixture = {
      repoDir,
      canaries,
      vault,
      vaultService,
      registry,
      bag,
      redactor,
      sensitiveValues,
      evaluator,
      scope,
      loader,
      service: new DefaultMethodExecutionService(),
      dataRepo,
      outputs,
      events,
      context: (modelType, definition, methodName, overrides = {}) => ({
        signal: new AbortController().signal,
        repoDir,
        modelType,
        modelId: definition.id,
        globalArgs: definition.globalArguments,
        definition: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
        },
        methodName,
        logger: getLogger(["test", "typed-destinations"]),
        dataRepository: dataRepo,
        definitionRepository: definitionRepo,
        outputRepository,
        vaultService,
        redactor,
        vaultSecrets: bag,
        onEvent: (event) => {
          events.push(event);
        },
        extensionFile: () => {
          throw new Error("extensionFile not stubbed in this test");
        },
        createCelEnvironment: createExtensionCelEnvironment,
        ...overrides,
      }),
      access: (fn) =>
        runWithVaultAccess(
          RunVaultAccess.create({ allowedVaults: [VAULT] }),
          fn,
        ),
      ref: (i) =>
        bag.addSecret(
          { vaultName: VAULT, key: keyOf(i) },
          `methods.create.arguments.m${i}`,
        ),
      dataRef: () => bag.addDataReference(DATA_REF, "db/main.password"),
    };
    await fn(fixture);
  } finally {
    vault.dispose();
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** What the recorder saw at each boundary. */
interface Seen {
  method?: {
    args: Record<string, unknown>;
    globalArgs: Record<string, unknown>;
  };
  check?: {
    globalArgs: Record<string, unknown>;
    methodArgs: Record<string, unknown>;
  };
}

/**
 * A per-run type with a string field per canary as method arguments and as
 * optional global arguments, a refusing `workingDir`, a recording check and
 * a recording method.
 */
function recorder(canaries: readonly Canary[], seen: Seen): ModelDefinition {
  const strings = (prefix: string) =>
    z.object(
      Object.fromEntries(canaries.map((_, i) => [`${prefix}${i}`, z.string()])),
    );
  return {
    type: ModelType.create(`test/typed-recorder-${crypto.randomUUID()}`),
    version: "2026.10.20.1",
    globalArguments: strings("g").partial(),
    methods: {
      create: {
        description: "Records its arguments",
        arguments: strings("m").partial().extend({
          workingDir: z.string().meta({ secrets: "refuse" }).optional(),
        }),
        execute: (args, context) => {
          seen.method = {
            args: { ...(args as Record<string, unknown>) },
            globalArgs: { ...context.globalArgs },
          };
          return Promise.resolve({});
        },
      },
    },
    checks: {
      record: {
        description: "Records what a pre-flight check receives",
        execute: (context) => {
          seen.check = {
            globalArgs: { ...context.globalArgs },
            methodArgs: { ...context.unresolvedMethodArgs },
          };
          return Promise.resolve({ pass: true });
        },
      },
    },
  };
}

/** The value kind of each canary's entry in `values`, by class. */
function kindsByClass(
  canaries: readonly Canary[],
  values: Record<string, unknown> | undefined,
  prefix: string,
): Record<string, ValueKind> {
  return Object.fromEntries(
    canaries.map((
      c,
      i,
    ) => [c.class, classifyValue(values?.[`${prefix}${i}`], c)]),
  );
}

function allOf(
  canaries: readonly Canary[],
  kind: ValueKind,
  except: Set<string> = new Set(),
): Record<string, ValueKind> {
  return Object.fromEntries(
    canaries.map((c) => [c.class, except.has(c.class) ? "absent" : kind]),
  );
}

/** Lowercase hex of the UTF-8 bytes of `value`. */
function utf8Hex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Runs the shell behavior on `definition` and returns its stdout. */
async function runShell(
  f: Fixture,
  definition: Definition,
): Promise<string> {
  await f.access(() =>
    f.service.executeWorkflow(
      definition,
      shellModel,
      "execute",
      f.context(SHELL_MODEL_TYPE, definition, "execute"),
      { secretLoader: f.loader },
    )
  );
  const content = await f.dataRepo.getContent(
    SHELL_MODEL_TYPE,
    definition.id,
    "result",
  );
  assert(content !== null, "the shell wrote no result");
  const result = JSON.parse(new TextDecoder().decode(content)) as {
    stdout: string;
    exitCode: number;
  };
  assertEquals(result.exitCode, 0, result.stdout);
  return result.stdout;
}

Deno.test("typed secret destinations: a refusing field, an environment name or a prohibited shell placement is refused before any read, check or method, wherever it was authored", async () => {
  await withFixture(true, async (f) => {
    const seen: Seen = {};
    const model = recorder(f.canaries, seen);
    const secret = f.ref(0);
    const data = f.dataRef();
    const run = (
      modelDef: ModelDefinition,
      methodName: string,
      definition: Definition,
    ) =>
      f.access(() =>
        f.service.executeWorkflow(
          definition,
          modelDef,
          methodName,
          f.context(modelDef.type, definition, methodName),
          { secretLoader: f.loader },
        )
      );
    const cases: [string, () => Promise<unknown>, string][] = [
      [
        "a refusing method field",
        () =>
          run(
            model,
            "create",
            Definition.create({
              name: "refused-field",
              globalArguments: {},
              methods: { create: { arguments: { workingDir: secret } } },
            }),
          ),
        "method argument 'workingDir'",
      ],
      [
        "workingDir authored under globalArguments of command/shell",
        () =>
          run(
            shellModel,
            "execute",
            Definition.create({
              name: "refused-global-dir",
              globalArguments: { workingDir: data, run: "echo hi" },
              methods: { execute: { arguments: {} } },
            }),
          ),
        "method argument 'workingDir'",
      ],
      [
        "a data value in a quoted here-document, run authored under globalArguments",
        () =>
          run(
            shellModel,
            "execute",
            Definition.create({
              name: "refused-heredoc",
              globalArguments: { run: `cat <<'EOF'\n${data}\nEOF` },
              methods: { execute: { arguments: {} } },
            }),
          ),
        "the shell command inside a here-document with a quoted delimiter",
      ],
      [
        "an environment variable name, env authored under globalArguments",
        () =>
          run(
            shellModel,
            "execute",
            Definition.create({
              name: "refused-env-name",
              globalArguments: { env: { [secret]: "x" } },
              methods: { execute: { arguments: { run: "echo hi" } } },
            }),
          ),
        "an environment variable name",
      ],
    ];
    for (const [name, attempt, destination] of cases) {
      const error = await assertRejects(
        attempt,
        SecretDestinationRefusedError,
        undefined,
        name,
      );
      assertEquals(error.destination, destination, name);
      assertEquals(error.code, "secret_destination_refused", name);
      assertEquals(error.message.includes(secret), false, name);
      assertEquals(error.message.includes(data), false, name);
    }
    // Zero reads, no check, no method, no shell, nothing written.
    assertEquals(f.vault.reads, []);
    assertEquals(seen, {});
    assertEquals(await f.dataRepo.findAllGlobal(), []);
    assertEquals(f.events, []);
  });
});

Deno.test("typed secret destinations: every canary class reaches method arguments, globalArgs and the check exactly, with one load per reference per attempt", async () => {
  await withFixture(true, async (f) => {
    const seen: Seen = {};
    const model = recorder(f.canaries, seen);
    const refs = f.canaries.map((_, i) => f.ref(i));
    const definition = Definition.create({
      name: "delivered",
      globalArguments: Object.fromEntries(
        f.canaries.flatMap((c, i) =>
          NOT_GLOBAL.has(c.class) ? [] : [[`g${i}`, refs[i]]]
        ),
      ),
      methods: {
        create: {
          arguments: Object.fromEntries(
            f.canaries.map((_, i) => [`m${i}`, refs[i]]),
          ),
        },
      },
    });
    await f.access(() =>
      f.service.executeWorkflow(
        definition,
        model,
        "create",
        f.context(model.type, definition, "create"),
        { secretLoader: f.loader },
      )
    );
    assertEquals(
      kindsByClass(f.canaries, seen.method?.args, "m"),
      allOf(f.canaries, "plaintext"),
    );
    assertEquals(
      kindsByClass(f.canaries, seen.method?.globalArgs, "g"),
      allOf(f.canaries, "plaintext", NOT_GLOBAL),
    );
    assertEquals(
      kindsByClass(f.canaries, seen.check?.globalArgs, "g"),
      allOf(f.canaries, "plaintext", NOT_GLOBAL),
    );
    assertEquals(
      kindsByClass(f.canaries, seen.check?.methodArgs, "m"),
      allOf(f.canaries, "sentinel"),
    );
    // One load per reference for the attempt, none for anything else.
    assertEquals(
      Object.fromEntries(f.canaries.map((_, i) => [keyOf(i), 1])),
      Object.fromEntries(
        f.canaries.map((_, i) => [keyOf(i), f.vault.readsOf(keyOf(i))]),
      ),
    );
    assertEquals(f.vault.reads.length, f.canaries.length);
  });
});

Deno.test(
  "typed secret destinations: the shell environment receives each canary exactly and the shell's own argv holds none",
  posix,
  async () => {
    await withFixture(true, async (f) => {
      const refs = f.canaries.map((_, i) => f.ref(i));
      const marker = `STEP_${crypto.randomUUID().slice(0, 8)}`;
      // Prints each variable's UTF-8 bytes as hex, so the output never
      // holds a value and redaction cannot change what is compared. On
      // Linux the shell also prints its own argv as hex.
      const lines = [
        `echo ${marker}`,
        `i=0; while [ $i -lt ${f.canaries.length} ]; do`,
        `  eval "v=\\\${C_$i}"`,
        `  printf '%s:' "$i"; printf %s "$v" | od -An -tx1 | tr -d ' \\n'; echo`,
        `  i=$((i + 1))`,
        `done`,
        `echo "ref:${refs[0]}" > /dev/null`,
      ];
      if (Deno.build.os === "linux") {
        lines.push(
          `printf 'argv:'; od -An -tx1 < /proc/$$/cmdline | tr -d ' \\n'; echo`,
        );
      }
      const definition = Definition.create({
        name: "shell-env",
        globalArguments: {},
        methods: {
          execute: {
            arguments: {
              run: lines.join("\n"),
              env: Object.fromEntries(
                f.canaries.map((_, i) => [`C_${i}`, refs[i]]),
              ),
            },
          },
        },
      });
      const stdout = await runShell(f, definition);
      const out = stdout.split("\n");
      const received = Object.fromEntries(
        f.canaries.map((c, i) => {
          const line = out.find((l) => l.startsWith(`${i}:`));
          return [c.class, line?.slice(`${i}:`.length)];
        }),
      );
      assertEquals(
        received,
        Object.fromEntries(f.canaries.map((c) => [c.class, utf8Hex(c.value)])),
      );
      if (Deno.build.os === "linux") {
        const argv = out.find((l) => l.startsWith("argv:"))!.slice(5);
        // The command text names the environment variable, never a value.
        assert(
          argv.includes(utf8Hex("__SWAMP_VAULT_0")),
          "no reference in argv",
        );
        for (const canary of f.canaries.filter((c) => c.unique)) {
          assertEquals(
            argv.includes(utf8Hex(canary.value)),
            false,
            `${canary.class} in argv`,
          );
        }
      }
      // Each reference loaded once for the attempt.
      for (const [i] of f.canaries.entries()) {
        assertEquals(f.vault.readsOf(keyOf(i)), 1, keyOf(i));
      }
    });
  },
);

Deno.test("typed secret destinations: a NUL in a loaded environment value fails before any launch with a value-free error and no result, with ignoreExitCode too", async () => {
  await withFixture(true, async (f) => {
    const nul = f.bag.addSecret(
      { vaultName: VAULT, key: "nul" },
      "methods.execute.arguments.env",
    );
    // Under an authored key the error names the variable; in the command,
    // where the name is generated, it names the vault and key.
    const placements: [Record<string, unknown>, string][] = [
      [{ run: "echo hi", env: { X: nul } }, "the environment variable 'X'"],
      [{ run: `echo ${nul}` }, "the secret 'nul' in vault 'canary'"],
    ];
    let attempts = 0;
    for (const [args, named] of placements) {
      for (const ignoreExitCode of [false, true]) {
        attempts++;
        const definition = Definition.create({
          name: `nul-${attempts}`,
          globalArguments: {},
          methods: { execute: { arguments: { ...args, ignoreExitCode } } },
        });
        // The in-process executor reports a method's error by its message,
        // which carries the code; the method itself threw the coded error
        // (see shell_model_test).
        const error = await assertRejects(
          () =>
            f.access(() =>
              f.service.executeWorkflow(
                definition,
                shellModel,
                "execute",
                f.context(SHELL_MODEL_TYPE, definition, "execute"),
                { secretLoader: f.loader },
              )
            ),
          Error,
        );
        assertStringIncludes(
          error.message,
          `(${SHELL_ENVIRONMENT_VALUE_REFUSED})`,
        );
        assertStringIncludes(error.message, named);
        assertEquals(error.message.includes("inside"), false);
      }
    }
    // The check depends on the value, so each attempt loads, then launches
    // nothing and writes nothing.
    assertEquals(
      f.vault.readsOf("nul"),
      attempts,
      JSON.stringify(f.vault.reads),
    );
    assertEquals(await f.dataRepo.findAllGlobal(), []);
    // The repository saw each record twice, running then failed.
    const failed = [...new Set(f.outputs)].filter((o) => o.status === "failed");
    assertEquals(failed.length, attempts);
    for (const output of failed) {
      assertEquals(output.error?.message.includes("inside"), false);
    }
  });
});

Deno.test("typed secret destinations: a failed method leaves an output record with its error redacted of values and sentinels", async () => {
  await withFixture(true, async (f) => {
    const secret = f.ref(5);
    const model: ModelDefinition = {
      type: ModelType.create(`test/typed-leaky-${crypto.randomUUID()}`),
      version: "2026.10.20.1",
      methods: {
        create: {
          description: "Echoes its argument into its error",
          arguments: z.object({ token: z.string() }),
          execute: (args) => {
            throw new Error(
              `leaked ${(args as { token: string }).token} and ${secret}`,
            );
          },
        },
      },
    };
    const definition = Definition.create({
      name: "leaky",
      globalArguments: {},
      methods: { create: { arguments: { token: secret } } },
    });
    await assertRejects(
      () =>
        f.access(() =>
          f.service.executeWorkflow(
            definition,
            model,
            "create",
            f.context(model.type, definition, "create"),
            { secretLoader: f.loader },
          )
        ),
      Error,
      "leaked",
    );
    const failed = f.outputs.find((o) => o.status === "failed");
    assertEquals(failed?.error?.message, "leaked *** and ***");
    assertEquals(failed?.error?.message.includes(f.canaries[5].value), false);
  });
});

Deno.test("typed secret destinations: a stand-in and a mask derive from a typed evaluation's reference with no load", async () => {
  await withFixture(true, async (f) => {
    const result = await f.access(() =>
      f.evaluator.evaluateAsync(
        `vault.get('${VAULT}', 'k3') + '-suffix'`,
        {},
        f.scope,
      )
    );
    assert(typeof result === "string");
    // The existence check probed once (this vault has no has()); nothing
    // else reads: the stand-in and the mask come from the registry.
    const probes = f.vault.readsOf("k3");
    assertEquals(
      f.sensitiveValues.withPlaceholders(result),
      "sensitive-canary.k3-suffix",
    );
    assertEquals(f.sensitiveValues.masked(result), "***-suffix");
    assertEquals(f.redactor.redact(result), "***-suffix");
    assertEquals(f.vault.readsOf("k3"), probes);
    assertEquals(result.includes(f.canaries[3].value), false);
  });
});

Deno.test(
  "typed secret destinations: option off, a refusing field is delivered and a quoted here-document pastes a data value with a warning, as today",
  posix,
  async () => {
    await withFixture(false, async (f) => {
      const seen: Seen = {};
      const model = recorder(f.canaries, seen);
      const secret = f.ref(0);
      const definition = Definition.create({
        name: "legacy-field",
        globalArguments: {},
        methods: { create: { arguments: { workingDir: secret } } },
      });
      await f.access(() =>
        f.service.executeWorkflow(
          definition,
          model,
          "create",
          f.context(model.type, definition, "create"),
          { secretLoader: f.loader },
        )
      );
      assertEquals(seen.method?.args.workingDir, f.canaries[0].value);
      assertEquals(f.vault.readsOf(keyOf(0)), 1);

      const legacy = f.bag.addDataSecret("legacy-value", DATA_REF);
      const shell = Definition.create({
        name: "legacy-heredoc",
        globalArguments: {},
        methods: {
          execute: { arguments: { run: `cat <<'EOF'\n${legacy}\nEOF` } },
        },
      });
      const stdout = await runShell(f, shell);
      assertEquals(stdout, "legacy-value");
      assertEquals(
        f.events.map((e) => e.type).filter((t) =>
          t === "sensitive_value_in_command_line"
        ),
        ["sensitive_value_in_command_line"],
      );
      // Nothing was derived from the sentinel.
      assertEquals(f.sensitiveValues.masked(legacy), legacy);
    });
  },
);

Deno.test(
  "typed secret destinations: a run authored under globalArguments is placed through the environment, so the shell's own argv holds the reference and no plaintext",
  posix,
  async () => {
    await withFixture(true, async (f) => {
      const ref = f.ref(4);
      const marker = `STEP_${crypto.randomUUID().slice(0, 8)}`;
      const lines = [
        `echo ${marker}`,
        `printf 'value:'; printf %s "${ref}" | od -An -tx1 | tr -d ' \\n'; echo`,
      ];
      if (Deno.build.os === "linux") {
        lines.push(
          `printf 'argv:'; od -An -tx1 < /proc/$$/cmdline | tr -d ' \\n'; echo`,
        );
      }
      const definition = Definition.create({
        name: "shell-global-run",
        globalArguments: { run: lines.join("\n") },
        methods: { execute: { arguments: {} } },
      });
      const out = (await runShell(f, definition)).split("\n");
      const value = out.find((l) => l.startsWith("value:"))!.slice(6);
      assertEquals(value, utf8Hex(f.canaries[4].value));
      if (Deno.build.os === "linux") {
        const argv = out.find((l) => l.startsWith("argv:"))!.slice(5);
        assert(
          argv.includes(utf8Hex("__SWAMP_VAULT_0")),
          "no reference in argv",
        );
        assertEquals(argv.includes(utf8Hex(f.canaries[4].value)), false);
      }
      assertEquals(f.vault.readsOf(keyOf(4)), 1);
    });
  },
);
