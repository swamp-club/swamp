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
 * Integration test for definition staleness across a bundle upgrade
 * (swamp-club#900).
 *
 * Wires the real YAML definition repository on a temp filesystem against the
 * real model registry and upgrade service, and walks the sequence that used to
 * strand an instance permanently:
 *
 * 1. An instance is created against v1 of a model type.
 * 2. The extension ships v2 with a changed default but no upgrade entry.
 * 3. Something performs an ordinary save — `model edit`, the serve API, a
 *    workflow auto-definition.
 * 4. The extension later ships the upgrade entry it should have shipped.
 *
 * Before the fix, step 3 restamped typeVersion to v2 without migrating the
 * arguments, so the upgrade in step 4 could never run.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { resolveStaleness } from "../src/domain/definitions/definition_staleness.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { DefinitionUpgradeService } from "../src/domain/models/definition_upgrade_service.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { resolveEffectiveDefinitionsDir } from "../src/infrastructure/persistence/paths.ts";

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
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Registers the type at `version`, replacing any previous registration. */
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

    // 1. Instance created against v1, carrying v1's defaulted arguments.
    const created = Definition.create({
      name: "factory",
      type: TYPE.normalized,
      typeVersion: V1,
      globalArguments: { project: "demo", fields: ["name", "path"] },
    });
    await repo.save(TYPE, created);

    // 2. The extension ships v2 with no upgrade entry.
    installBundle(V2, false);

    const beforeSave = await repo.findByName(TYPE, "factory");
    assertEquals(
      resolveStaleness(beforeSave!.typeVersion, V2, []).state,
      "stranded",
      "v2 with no upgrade entry leaves the instance stranded",
    );

    // 3. An ordinary save — the step that used to silently restamp.
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

    // 4. The extension ships the upgrade entry it should have shipped.
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

    // The migrated definition round-trips, and is now current.
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
 * A hand-authored definition under `models/` carries whatever its author wrote,
 * and `typeVersion` is the one field they are most likely to leave out — it
 * records an internal versioning concept, not anything about their
 * configuration. The upgrade service must not read that omission as "predates
 * the chain, apply all of it": the arguments below are already in the shape the
 * current version expects, and running the chain would strip the field the
 * upgrade adds (swamp-club#2412).
 *
 * Written as YAML on disk rather than through `Definition.create` so the test
 * exercises the same load path a checked-in file takes.
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
      // No `typeVersion:` line — exactly what a person writes by hand.
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

      // And the file still records no typeVersion after an ordinary save:
      // backfilling would claim a version nothing verified the arguments
      // against.
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
      // Someone meant to record a version and used the wrong format. Reading
      // that as "records nothing" would throw away what they wrote.
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
      // The value survives loading, so `model get` can name it.
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
