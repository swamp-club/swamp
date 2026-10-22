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
 * A vault-only definition on a type whose schemas hold a transform — in a
 * method that is not run, on a global the type does not mark sensitive, and
 * as the run method's own pipeline into a sensitive output — caches its
 * references and authored literals and replays under --last-evaluated
 * (swamp-club#3681). A position a transform might feed is only potentially
 * sensitive, so only data is masked there.
 */

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelMethodRun,
  type ModelMethodRunEvent,
} from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VAULT = "secrets";
const VAULT_VALUE = "VAULT-VALUE-3681-transform";
const VAULT_REF = `\${{ vault.get('${VAULT}', 'probe') }}`;

const secret = z.string().meta({ sensitive: true });

function errorsOf(events: ModelMethodRunEvent[]) {
  return events.flatMap((event) => event.kind === "error" ? [event.error] : []);
}

async function cacheOf(
  dir: string,
  name: string,
): Promise<Record<string, unknown>> {
  for await (
    const entry of walk(join(dir, ".swamp", "definitions-evaluated"), {
      includeDirs: false,
      match: [new RegExp(`${name}\\.yaml$`)],
    })
  ) {
    return parseYaml(await Deno.readTextFile(entry.path)) as Record<
      string,
      unknown
    >;
  }
  throw new Error(`no evaluated cache for ${name}`);
}

Deno.test("evaluated cache: a transform in an unrelated method, on a non-sensitive global, or as the run method's own pipeline leaves a vault-only definition's references and authored literals cached, and --last-evaluated replays it (swamp-club#3681)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3681-transform-" });
  const type = ModelType.create(
    `@test/transform-replay-${crypto.randomUUID()}`,
  );
  const received: Record<string, unknown>[] = [];
  const record = (args: unknown) => {
    received.push(args as Record<string, unknown>);
    return Promise.resolve({ dataHandles: [] });
  };
  modelRegistry.register({
    type,
    version: "2026.10.21.1",
    globalArguments: z.object({
      apiKey: secret.optional(),
      region: z.string().optional(),
      // A transform on a global the type does not mark sensitive.
      count: z.string().transform(Number).optional(),
    }),
    methods: {
      run: {
        description: "run",
        arguments: z.object({ token: secret.optional() }),
        execute: record,
      },
      // An unrelated method whose sensitive field has a transform.
      other: {
        description: "other",
        arguments: z.object({ token: secret.transform((s) => s.trim()) }),
        execute: record,
      },
      // A root pipeline into a sensitive output.
      pipeline: {
        description: "pipeline",
        arguments: z.object({ raw: z.string() }).transform((x) => ({
          token: x.raw,
        })).pipe(z.object({ token: secret })),
        execute: record,
      },
    },
  });
  try {
    await initializeTestRepo(dir);
    await new YamlVaultConfigRepository(dir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, "local_encryption", {
        auto_generate: true,
        base_dir: dir,
      }),
    );
    const vault = await VaultService.fromRepository(dir);
    await vault.put(VAULT, "probe", VAULT_VALUE);
    const globals = { apiKey: VAULT_REF, region: "eu" };
    const repo = createRepositoryContext({ repoDir: dir });
    try {
      await repo.definitionRepo.save(
        type,
        Definition.create({
          name: "vault-only",
          type: type.normalized,
          globalArguments: globals,
          methods: {
            run: { arguments: { token: VAULT_REF } },
            pipeline: { arguments: { raw: VAULT_REF } },
          },
        }),
      );
      const deps = await createModelMethodRunDeps(dir, repo, {
        defaultVault: VAULT,
      });
      const run = (method: string, lastEvaluated: boolean) =>
        collect(
          modelMethodRun(createLibSwampContext(), deps, {
            modelIdOrName: "vault-only",
            methodName: method,
            inputs: {},
            lastEvaluated,
          }),
        );
      for (const method of ["run", "pipeline"]) {
        received.length = 0;
        assertEquals(errorsOf(await run(method, false)), [], method);
        const cache = await cacheOf(dir, "vault-only");
        assertEquals(cache.globalArguments, globals, method);
        assertEquals(cache.maskedPaths, undefined, method);
        assertEquals(
          (cache.methods as Record<string, { arguments: unknown }>)[method]
            .arguments,
          method === "run" ? { token: VAULT_REF } : { raw: VAULT_REF },
          method,
        );
        assertEquals(errorsOf(await run(method, true)), [], method);
        assertEquals(received, [
          { token: VAULT_VALUE },
          { token: VAULT_VALUE },
        ], method);
      }
    } finally {
      repo.catalogStore.close();
    }
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
