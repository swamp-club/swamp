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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import {
  type Canary,
  classifyValue,
  type CountingVault,
  generateCanaries,
  registerCountingVault,
  type ValueKind,
} from "./canary_values.ts";

await initializeLogging({});

const posix = { ignore: Deno.build.os === "windows" };

const VAULT = "canary";

/**
 * a global argument whose resolved value reads as expression syntax is refused,
 * so this class is checked through other paths here and its global-argument
 * behavior is characterized in the acceptance suite
 */
const NOT_GLOBAL = new Set(["reference-shaped"]);

function keyOf(i: number): string {
  return `k${i}`;
}

function ref(i: number): string {
  return `\${{ vault.get('${VAULT}', '${keyOf(i)}') }}`;
}

function perCanary<T>(
  canaries: readonly Canary[],
  prefix: string,
  value: (i: number) => T,
): Record<string, T> {
  return Object.fromEntries(
    canaries.map((_, i) => [`${prefix}${i}`, value(i)]),
  );
}

async function withCanaryRepo(
  fn: (
    repoDir: string,
    canaries: Canary[],
    vault: CountingVault,
  ) => Promise<void>,
): Promise<void> {
  const canaries = generateCanaries();
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3511-" });
  let vault: CountingVault | undefined;
  try {
    vault = registerCountingVault(
      Object.fromEntries(canaries.map((c, i) => [keyOf(i), c.value])),
    );
    await initializeTestRepo(repoDir);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, vault.type, {}),
    );
    await fn(repoDir, canaries, vault);
  } finally {
    vault?.dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

interface Seen {
  method?: {
    args: Record<string, unknown>;
    globalArgs: Record<string, unknown>;
  };
  check?: {
    globalArgs: Record<string, unknown>;
    methodArgs: Record<string, unknown>;
  };
  read?: Record<string, unknown> | null;
}

function registerRecorder(canaries: readonly Canary[], seen: Seen): string {
  const type = ModelType.create(`test/canary-recorder-${crypto.randomUUID()}`);
  const strings = (prefix: string) =>
    z.object(perCanary(canaries, prefix, () => z.string()));
  modelRegistry.register({
    type,
    version: "2026.10.15.1",
    globalArguments: strings("g").partial(),
    resources: {
      store: {
        description: "Canaries stored as sensitive fields",
        schema: z.object(
          perCanary(canaries, "s", () => z.string().meta({ sensitive: true })),
        ),
        lifetime: "infinite",
        garbageCollection: 5,
        vaultName: VAULT,
      },
    },
    checks: {
      record: {
        description: "Records what a pre-flight check receives",
        appliesTo: ["create"],
        execute: (context) => {
          seen.check = {
            globalArgs: { ...context.globalArgs },
            methodArgs: { ...context.unresolvedMethodArgs },
          };
          return Promise.resolve({ pass: true });
        },
      },
    },
    methods: {
      create: {
        description: "Records its arguments and stores them",
        arguments: strings("m"),
        execute: async (args, context) => {
          const received = args as Record<string, string>;
          seen.method = {
            args: { ...received },
            globalArgs: { ...context.globalArgs },
          };
          const handle = await context.writeResource!(
            "store",
            "main",
            perCanary(canaries, "s", (i) => received[`m${i}`]),
          );
          return { dataHandles: [handle] };
        },
      },
      update: {
        description: "Reads the stored canaries back",
        arguments: z.object({}),
        execute: async (_args, context) => {
          seen.read = await context.readResource!("main");
          return {};
        },
      },
    },
  });
  return type.normalized;
}

async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
  onEvent?: (event: WorkflowRunEvent) => void,
): Promise<{ status?: string; errors: string[] }> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  let status: string | undefined;
  const errors: string[] = [];
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "completed") status = event.run.status;
      if (event.kind === "step_failed") errors.push(event.error);
      onEvent?.(event);
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  return { status, errors };
}

async function runRecorder(
  repoDir: string,
  canaries: readonly Canary[],
): Promise<Seen> {
  const seen: Seen = {};
  const type = registerRecorder(canaries, seen);
  try {
    await runRecorderSteps(repoDir, canaries, type);
  } finally {
    modelRegistry.invalidateType(type);
  }
  return seen;
}

async function runRecorderSteps(
  repoDir: string,
  canaries: readonly Canary[],
  type: string,
): Promise<void> {
  const globals = Object.fromEntries(
    canaries.flatMap((c, i) =>
      NOT_GLOBAL.has(c.class) ? [] : [[`g${i}`, ref(i)]]
    ),
  );
  const { status, errors } = await runWorkflow(
    repoDir,
    Workflow.create({
      name: `canary-${crypto.randomUUID().slice(0, 8)}`,
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "create",
            task: StepTask.directExecution(
              type,
              "recorder",
              "create",
              perCanary(canaries, "m", ref),
              globals,
            ),
          }),
          Step.create({
            name: "read",
            task: StepTask.directExecution(
              type,
              "recorder",
              "update",
              {},
              globals,
            ),
            dependsOn: [{
              step: "create",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ],
      })],
    }),
  );
  assertEquals(status, "succeeded", errors.join("\n"));
}

function kindsByClass(
  canaries: readonly Canary[],
  values: Record<string, unknown> | null | undefined,
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
): Record<string, ValueKind> {
  return Object.fromEntries(canaries.map((c) => [c.class, kind]));
}

function globalsOf(
  canaries: readonly Canary[],
  kind: ValueKind,
): Record<string, ValueKind> {
  return Object.fromEntries(
    canaries.map((c) => [c.class, NOT_GLOBAL.has(c.class) ? "absent" : kind]),
  );
}

function readCounts(
  vault: CountingVault,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { key } of vault.reads) {
    const stored = key.match(/-(s\d+)$/);
    const name = /^k\d+$/.test(key) ? key : `stored-${stored?.[1] ?? key}`;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

Deno.test(
  "secret canary boundaries: method arguments and globalArgs receive each canary exactly",
  async () => {
    await withCanaryRepo(async (repoDir, canaries, vault) => {
      const seen = await runRecorder(repoDir, canaries);
      assertEquals(
        kindsByClass(canaries, seen.method?.args, "m"),
        allOf(canaries, "plaintext"),
      );
      assertEquals(
        kindsByClass(canaries, seen.method?.globalArgs, "g"),
        globalsOf(canaries, "plaintext"),
      );
      // each step's attempt loads each referenced key once and the run probes
      // each key once, as this vault has no has(); stored fields load only in
      // the trusted readResource call
      assertEquals(
        readCounts(vault),
        Object.fromEntries([
          ...canaries.map((
            c,
            i,
          ) => [keyOf(i), NOT_GLOBAL.has(c.class) ? 2 : 3]),
          ...canaries.map((_, i) => [`stored-s${i}`, 1]),
        ]),
      );
      assert(vault.reads.every((r) => r.vault === VAULT));
    });
  },
);

Deno.test(
  "secret canary boundaries: pre-flight checks receive resolved globalArgs and sentinel-form method arguments",
  async () => {
    await withCanaryRepo(async (repoDir, canaries) => {
      const seen = await runRecorder(repoDir, canaries);
      assertEquals(
        kindsByClass(canaries, seen.check?.globalArgs, "g"),
        globalsOf(canaries, "plaintext"),
      );
      assertEquals(
        kindsByClass(canaries, seen.check?.methodArgs, "m"),
        allOf(canaries, "sentinel"),
      );
    });
  },
);

Deno.test(
  "secret canary boundaries: local readResource returns each canary exactly",
  async () => {
    await withCanaryRepo(async (repoDir, canaries) => {
      const seen = await runRecorder(repoDir, canaries);
      assertEquals(
        kindsByClass(canaries, seen.read, "s"),
        allOf(canaries, "plaintext"),
      );
    });
  },
);

function registerEcho(canaries: readonly Canary[]): string {
  const type = ModelType.create(`test/canary-echo-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.11.04.1",
    methods: {
      echo: {
        description: "Logs each sensitive argument it receives",
        arguments: z.object(
          perCanary(canaries, "m", () => z.string().meta({ sensitive: true })),
        ),
        execute: (args, context) => {
          const received = args as Record<string, string>;
          // a plain-string message parses braces, which would alter the
          // reference-shaped canary before it is ever logged
          canaries.forEach((_, i) => {
            const value = received[`m${i}`];
            context.logger.info`echo-tagged ${i}: ${value}`;
            context.logger.info("echo-props {i}: {value}", { i, value });
          });
          return Promise.resolve({});
        },
      },
    },
  });
  return type.normalized;
}

function eventText(event: WorkflowRunEvent): string {
  const inspected = Deno.inspect(event, {
    depth: Infinity,
    strAbbreviateSize: Infinity,
    iterableLimit: Infinity,
  });
  try {
    return `${JSON.stringify(event)}\n${inspected}`;
  } catch {
    return inspected;
  }
}

Deno.test(
  "secret canary boundaries: workflow run events carry no canary a method logs",
  async () => {
    await withCanaryRepo(async (repoDir, canaries) => {
      const type = registerEcho(canaries);
      const events: WorkflowRunEvent[] = [];
      try {
        const { status, errors } = await runWorkflow(
          repoDir,
          Workflow.create({
            name: `canary-echo-${crypto.randomUUID().slice(0, 8)}`,
            jobs: [Job.create({
              name: "main",
              steps: [Step.create({
                name: "echo",
                task: StepTask.directExecution(
                  type,
                  "echo",
                  "echo",
                  perCanary(canaries, "m", ref),
                ),
              })],
            })],
          }),
          (event) => events.push(event),
        );
        assertEquals(status, "succeeded", errors.join("\n"));
      } finally {
        modelRegistry.invalidateType(type);
      }

      const lines = events.flatMap((e) =>
        e.kind === "method_output" ? [e.line] : []
      );
      assertEquals(lines.length, canaries.length * 2, lines.join("\n"));
      const text = events.map(eventText).join("\n");
      // escaping can hide a leaked value from a substring check, so its ASCII
      // prefix and suffix are checked as well
      const leaked = canaries.filter((c) => c.unique).flatMap((canary) =>
        [canary.value, canary.value.slice(0, 13), canary.value.slice(-10)]
            .some((form) => text.includes(form))
          ? [canary.class]
          : []
      );
      assertEquals(leaked, []);
      for (const canary of canaries.filter((c) => c.unique)) {
        const i = canaries.indexOf(canary);
        assert(
          lines.includes(`echo-tagged ${i}: ***`),
          `${canary.class}: ${lines.join("\n")}`,
        );
      }
    });
  },
);

function utf8Hex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function shellStdout(repoDir: string, marker: string): Promise<string> {
  for await (
    const entry of walk(join(repoDir, ".swamp", "data", "command", "shell"), {
      includeDirs: false,
    })
  ) {
    if (!entry.path.endsWith("raw")) continue;
    try {
      const parsed = JSON.parse(await Deno.readTextFile(entry.path)) as {
        stdout?: string;
      };
      if (parsed.stdout?.includes(marker)) return parsed.stdout;
    } catch {
      // not a result file
    }
  }
  throw new Error(`no shell output carrying ${marker}`);
}

Deno.test(
  "secret canary boundaries: shell env receives each canary",
  posix,
  async () => {
    await withCanaryRepo(async (repoDir, canaries) => {
      const marker = `STEP_${crypto.randomUUID().slice(0, 8)}`;
      // Prints each variable's UTF-8 bytes as hex, so the output never holds
      // the value itself and redaction cannot change what is compared.
      const run = [
        `echo ${marker}`,
        `i=0; while [ $i -lt ${canaries.length} ]; do`,
        `  eval "set=\\\${C_$i+x}"; eval "v=\\\${C_$i}"`,
        `  if [ "$set" = x ]; then`,
        `    printf '%s:' "$i"; printf %s "$v" | od -An -tx1 | tr -d ' \\n'; echo`,
        `  else echo "$i:unset"; fi`,
        `  i=$((i + 1))`,
        `done`,
      ].join("\n");
      const { status, errors } = await runWorkflow(
        repoDir,
        Workflow.create({
          name: `canary-env-${crypto.randomUUID().slice(0, 8)}`,
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "env",
              task: StepTask.directExecution(
                "command/shell",
                "canary-env",
                "execute",
                { run, env: perCanary(canaries, "C_", ref) },
              ),
            })],
          })],
        }),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      const lines = (await shellStdout(repoDir, marker)).split("\n");
      const received = Object.fromEntries(
        canaries.map((c, i) => {
          const line = lines.find((l) => l.startsWith(`${i}:`));
          return [c.class, line?.slice(`${i}:`.length)];
        }),
      );
      assertEquals(
        received,
        Object.fromEntries(canaries.map((c) => [c.class, utf8Hex(c.value)])),
      );
    });
  },
);

Deno.test(
  "secret canary boundaries: vault storage holds ciphertext only",
  async () => {
    const canaries = generateCanaries();
    const repoDir = await Deno.makeTempDir({ prefix: "swamp-3511-" });
    try {
      await initializeTestRepo(repoDir);
      await new YamlVaultConfigRepository(repoDir).save(
        VaultConfig.create(crypto.randomUUID(), VAULT, "local_encryption", {
          auto_generate: true,
          base_dir: repoDir,
        }),
      );
      const service = await VaultService.fromRepository(repoDir);
      for (const [i, canary] of canaries.entries()) {
        await service.put(VAULT, keyOf(i), canary.value);
      }
      for (const [i, canary] of canaries.entries()) {
        assertEquals(
          await service.get(VAULT, keyOf(i)),
          canary.value,
          canary.class,
        );
      }
      const holding: string[] = [];
      let files = 0;
      for await (
        const entry of walk(join(repoDir, ".swamp", "secrets"), {
          includeDirs: false,
        })
      ) {
        files++;
        const text = new TextDecoder("latin1").decode(
          await Deno.readFile(entry.path),
        );
        for (const canary of canaries.filter((c) => c.unique)) {
          const utf8 = new TextDecoder("latin1").decode(
            new TextEncoder().encode(canary.value),
          );
          const forms = [
            utf8,
            canary.value.slice(0, 13),
            canary.value.slice(-10),
          ];
          if (forms.some((form) => text.includes(form))) {
            holding.push(`${canary.class}: ${entry.name}`);
          }
        }
      }
      assert(
        files >= canaries.length,
        `only ${files} files under .swamp/secrets`,
      );
      assertEquals(holding, []);
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(repoDir, { recursive: true });
      }
    }
  },
);

Deno.test(
  "secret canary boundaries: serve resolves a remote readResource secret only for the dispatch that references it",
  async () => {
    const canaries = generateCanaries();
    const vault = registerCountingVault(
      Object.fromEntries(canaries.map((c, i) => [keyOf(i), c.value])),
    );
    try {
      const vaultService = new VaultService();
      vaultService.registerVault({ name: VAULT, type: vault.type, config: {} });
      const dispatches = new DispatchRegistry();
      const allowed = canaries.map((_, i) => i).filter((i) => i % 2 === 0);
      dispatches.register({
        workerName: "worker-1",
        dispatchId: "d-1",
        leaseId: "l-1",
        modelDef: {} as never,
        modelType: ModelType.create("test/canary"),
        modelId: "m-1",
        methodName: "update",
        definitionName: "recorder",
        definitionTags: {},
        allowedSecrets: {
          staticRefs: allowed.map((i) => ({
            vaultName: VAULT,
            secretKey: keyOf(i),
          })),
          hasDynamicRefs: false,
        },
      });
      const service = new CapabilityService({
        repoDir: "/nonexistent",
        repoContext: {} as never,
        dispatches,
        createVaultService: () => Promise.resolve(vaultService),
      });
      const resolve = (i: number) =>
        service.resolveSecret("worker-1", {
          vaultName: VAULT,
          secretKey: keyOf(i),
          dispatchId: "d-1",
        });

      for (const i of allowed) {
        assertEquals((await resolve(i)).value, canaries[i].value);
        assertEquals(vault.readsOf(keyOf(i)), 1);
      }
      for (const [i, canary] of canaries.entries()) {
        if (allowed.includes(i)) continue;
        const error = await assertRejects(() => resolve(i), Error);
        assertEquals(vault.readsOf(keyOf(i)), 0);
        if (canary.unique) {
          assert(!error.message.includes(canary.value), canary.class);
        }
      }
      dispatches.unregister("worker-1", "d-1");
      const readsBefore = vault.reads.length;
      await assertRejects(
        () => resolve(allowed[0]),
        Error,
        "no active dispatch",
      );
      assertEquals(vault.reads.length, readsBefore);
    } finally {
      vault.dispose();
    }
  },
);
