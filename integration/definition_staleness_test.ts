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

import { assertEquals } from "@std/assert";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { resolveStaleness } from "../src/domain/definitions/definition_staleness.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { DefinitionUpgradeService } from "../src/domain/models/definition_upgrade_service.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

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
