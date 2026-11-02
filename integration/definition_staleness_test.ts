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

import { assertEquals, assertThrows } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { resolveStaleness } from "../src/domain/definitions/definition_staleness.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { DefinitionUpgradeService } from "../src/domain/models/definition_upgrade_service.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { resolveEffectiveDefinitionsDir } from "../src/infrastructure/persistence/paths.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { buildMethodContext } from "../src/domain/models/method_context.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";

const TYPE = ModelType.create("test/staleness-integration");
const V1 = "2026.01.01.1";
const V2 = "2026.06.01.1";

const globalArguments = z.object({
  project: z.string(),
  fields: z.array(z.string()).default(["name", "path"]),
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-staleness-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // EBUSY can fire on windows before V8 frees native sqlite handles; the
      // temp dir is ephemeral
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function installBundle(version: string, withUpgrade: boolean): void {
  modelRegistry.invalidateType(TYPE);
  modelRegistry.register({
    type: TYPE,
    version,
    globalArguments,
    methods: {},
    upgrades: withUpgrade
      ? [{
        toVersion: V2,
        description: "Add digest to fields",
        upgradeAttributes: (args: Record<string, unknown>) => ({
          ...args,
          fields: ["name", "path", "digest"],
        }),
      }]
      : undefined,
  });
}

Deno.test("definition staleness: an ordinary save does not strand an instance across a bundle upgrade", async () => {
  await withTempDir(async (dir) => {
    installBundle(V1, false);
    const repo = new YamlDefinitionRepository(dir, undefined, undefined, false);

    const created = Definition.create({
      name: "factory",
      type: TYPE.normalized,
      typeVersion: V1,
      globalArguments: { project: "demo", fields: ["name", "path"] },
    });
    await repo.save(TYPE, created);

    installBundle(V2, false);

    const beforeSave = await repo.findByName(TYPE, "factory");
    assertEquals(
      resolveStaleness(beforeSave!.typeVersion, V2, []).state,
      "stranded",
      "v2 with no upgrade entry leaves the instance stranded",
    );

    await repo.save(TYPE, beforeSave!);

    const afterSave = await repo.findByName(TYPE, "factory");
    assertEquals(
      afterSave!.typeVersion,
      V1,
      "save must not advance typeVersion without migrating arguments",
    );
    assertEquals(afterSave!.globalArguments, {
      project: "demo",
      fields: ["name", "path"],
    });

    installBundle(V2, true);

    const reloaded = await repo.findByName(TYPE, "factory");
    assertEquals(
      resolveStaleness(reloaded!.typeVersion, V2, [V2]).state,
      "upgradable",
      "with a covering upgrade entry the instance is migratable again",
    );

    const result = new DefinitionUpgradeService().upgrade(
      reloaded!,
      modelRegistry.get(TYPE)!,
    );
    assertEquals(result.upgraded, true, "the upgrade chain must still run");
    assertEquals(result.definition.globalArguments, {
      project: "demo",
      fields: ["name", "path", "digest"],
    });
    assertEquals(result.definition.typeVersion, V2);

    await repo.save(TYPE, result.definition);
    const migrated = await repo.findByName(TYPE, "factory");
    assertEquals(migrated!.typeVersion, V2);
    assertEquals(
      resolveStaleness(migrated!.typeVersion, V2, [V2]).state,
      "current",
    );

    modelRegistry.invalidateType(TYPE);
  });
});

/**
 * a hand-authored definition without typeVersion must not be read as predating
 * the chain: its arguments are already current and running the chain would
 * strip the field the upgrade adds
 */
const HAND_AUTHORED_TYPE = ModelType.create("test/hand-authored-definition");

Deno.test("definition upgrade: a hand-authored definition with no typeVersion is left as written", async () => {
  await withTempDir(async (dir) => {
    modelRegistry.invalidateType(HAND_AUTHORED_TYPE);
    modelRegistry.register({
      type: HAND_AUTHORED_TYPE,
      version: V2,
      globalArguments: z.object({
        project: z.string(),
        fields: z.array(z.string()),
      }),
      methods: {},
      upgrades: [{
        toVersion: V2,
        description: "Drop the retired `legacy` field",
        upgradeAttributes: (args: Record<string, unknown>) => {
          const next = { ...args };
          delete next.fields;
          return next;
        },
      }],
    });

    try {
      const typeDir = join(
        resolveEffectiveDefinitionsDir(dir),
        HAND_AUTHORED_TYPE.toDirectoryPath(),
      );
      await Deno.mkdir(typeDir, { recursive: true });
      await Deno.writeTextFile(
        join(typeDir, "factory.yaml"),
        [
          "id: 3f2a6f5e-9a21-4b3c-8d47-2e1f0c9b7a64",
          `type: ${HAND_AUTHORED_TYPE.normalized}`,
          "name: factory",
          "version: 1",
          "globalArguments:",
          "  project: demo",
          "  fields:",
          "    - name",
          "    - path",
          "",
        ].join("\n"),
      );

      const repo = new YamlDefinitionRepository(
        dir,
        undefined,
        undefined,
        false,
      );
      const loaded = await repo.findByName(HAND_AUTHORED_TYPE, "factory");
      assertEquals(loaded!.typeVersion, undefined);
      assertEquals(
        resolveStaleness(loaded!.typeVersion, V2, [V2]).state,
        "unknown",
      );

      const result = new DefinitionUpgradeService().upgrade(
        loaded!,
        modelRegistry.get(HAND_AUTHORED_TYPE)!,
      );

      assertEquals(result.upgraded, false, "the chain must not run");
      assertEquals(
        result.definition.globalArguments,
        {
          project: "demo",
          fields: ["name", "path"],
        },
        "arguments must survive verbatim — the chain would have dropped fields",
      );
      assertEquals(
        result.definition.typeVersion,
        undefined,
        "skipping is not migrating, so nothing may stamp the definition",
      );

      // no typeVersion is backfilled on save: it would claim a version nothing
      // verified the arguments against
      await repo.save(HAND_AUTHORED_TYPE, result.definition);
      const yaml = await Deno.readTextFile(join(typeDir, "factory.yaml"));
      assertEquals(yaml.includes("typeVersion"), false);
    } finally {
      modelRegistry.invalidateType(HAND_AUTHORED_TYPE);
    }
  });
});

Deno.test("definition upgrade: a hand-authored definition with a malformed typeVersion is refused", async () => {
  await withTempDir(async (dir) => {
    modelRegistry.invalidateType(HAND_AUTHORED_TYPE);
    modelRegistry.register({
      type: HAND_AUTHORED_TYPE,
      version: V2,
      globalArguments: z.object({ project: z.string() }),
      methods: {},
    });

    try {
      const typeDir = join(
        resolveEffectiveDefinitionsDir(dir),
        HAND_AUTHORED_TYPE.toDirectoryPath(),
      );
      await Deno.mkdir(typeDir, { recursive: true });
      // a wrongly formatted version must not be read as recording nothing,
      // which would throw away what the author wrote
      await Deno.writeTextFile(
        join(typeDir, "factory.yaml"),
        [
          "id: 3f2a6f5e-9a21-4b3c-8d47-2e1f0c9b7a64",
          `type: ${HAND_AUTHORED_TYPE.normalized}`,
          "name: factory",
          "version: 1",
          'typeVersion: "1.0"',
          "globalArguments:",
          "  project: demo",
          "",
        ].join("\n"),
      );

      const repo = new YamlDefinitionRepository(
        dir,
        undefined,
        undefined,
        false,
      );
      const loaded = await repo.findByName(HAND_AUTHORED_TYPE, "factory");
      assertEquals(loaded!.typeVersion, "1.0");
      assertEquals(
        resolveStaleness(loaded!.typeVersion, V2, []).state,
        "invalid",
      );

      assertThrows(
        () =>
          new DefinitionUpgradeService().upgrade(
            loaded!,
            modelRegistry.get(HAND_AUTHORED_TYPE)!,
          ),
        UserError,
        '"1.0"',
      );
    } finally {
      modelRegistry.invalidateType(HAND_AUTHORED_TYPE);
    }
  });
});

/**
 * the lazy upgrade persists the definition on any method run, read-only
 * included; a legacy uuid-named file moves to its name-based file in that write
 * and must keep its comments and layout
 */
const COMMENTED_TYPE = ModelType.create("test/commented-definition");

Deno.test("definition upgrade: a read-only method run keeps a legacy definition file's comments and layout", async () => {
  await withTempDir(async (dir) => {
    modelRegistry.invalidateType(COMMENTED_TYPE);
    const model = {
      type: COMMENTED_TYPE,
      version: V2,
      globalArguments: z.object({ host: z.string(), note: z.string() }),
      methods: {
        ping: {
          description: "Reads, writes nothing",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
      upgrades: [{
        toVersion: V2,
        description: "No-op upgrade",
        upgradeAttributes: (args: Record<string, unknown>) => args,
      }],
    };
    modelRegistry.register(model);

    const id = "7c1d9f0e-52ab-4c1e-9d3f-6a8b2e4f1c05";
    const typeDir = join(
      resolveEffectiveDefinitionsDir(dir),
      COMMENTED_TYPE.toDirectoryPath(),
    );
    await ensureDir(typeDir);
    const legacyPath = join(typeDir, `${id}.yaml`);
    const original = [
      "# Design note: the host comes from live data, unlike the prod sibling.",
      `type: ${COMMENTED_TYPE.normalized}`,
      `typeVersion: ${V1}`,
      `id: ${id}`,
      "name: nodes",
      "version: 1",
      "tags: {}",
      "globalArguments:",
      "  # the filter exists because of overlapping CIDRs",
      "  host: example.com",
      '  note: ${{ data.latest("some-other-model-with-a-long-name", "some-resource-name").attributes.someField }}',
      "methods: {}",
      "",
    ].join("\n");
    await Deno.writeTextFile(legacyPath, original);

    await ensureDir(join(dir, ".swamp", "data"));
    const catalogStore = new CatalogStore(
      join(dir, ".swamp", "data", "_catalog.db"),
    );
    try {
      const repo = new YamlDefinitionRepository(
        dir,
        undefined,
        undefined,
        false,
      );
      const run = async () => {
        const definition = await repo.findByName(COMMENTED_TYPE, "nodes");
        const context = buildMethodContext(
          {
            dataRepository: new FileSystemUnifiedDataRepository(
              dir,
              undefined,
              catalogStore,
            ),
            definitionRepository: repo,
            createCelEnvironment: createExtensionCelEnvironment,
          },
          {
            signal: new AbortController().signal,
            repoDir: dir,
            modelType: COMMENTED_TYPE,
            modelId: definition!.id,
            globalArgs: {},
            definition: {
              id: definition!.id,
              name: definition!.name,
              version: definition!.version,
              tags: definition!.tags,
            },
            methodName: "ping",
            logger: getLogger(["test", "definition-staleness"]),
          },
        );
        await new DefaultMethodExecutionService().executeWorkflow(
          definition!,
          model,
          "ping",
          context,
        );
      };

      await run();

      const namePath = join(typeDir, "nodes.yaml");
      const migrated = original.replace(
        `typeVersion: ${V1}`,
        `typeVersion: ${V2}`,
      );
      assertEquals(await Deno.readTextFile(namePath), migrated);
      assertEquals(
        (await Array.fromAsync(Deno.readDir(typeDir))).map((e) => e.name),
        ["nodes.yaml"],
        "the legacy uuid-named file is gone and nothing else was written",
      );

      await Deno.utime(namePath, new Date(0), new Date(0));
      await run();
      assertEquals(await Deno.readTextFile(namePath), migrated);
      assertEquals((await Deno.stat(namePath)).mtime?.getTime(), 0);
    } finally {
      catalogStore.close();
      modelRegistry.invalidateType(COMMENTED_TYPE);
    }
  });
});
