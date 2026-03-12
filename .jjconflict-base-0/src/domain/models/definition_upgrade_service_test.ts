// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals } from "@std/assert";
import { DefinitionUpgradeService } from "./definition_upgrade_service.ts";
import { Definition } from "../definitions/definition.ts";
import type { ModelDefinition, VersionUpgrade } from "./model.ts";
import { ModelType } from "./model_type.ts";

function createModelDef(
  version: string,
  upgrades?: VersionUpgrade[],
): ModelDefinition {
  return {
    type: ModelType.create("test/upgradeable"),
    version,
    methods: {},
    upgrades,
  };
}

Deno.test("DefinitionUpgradeService - no upgrade needed when versions match", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.06.01.1",
    globalArguments: { message: "hello" },
  });

  const modelDef = createModelDef("2025.06.01.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Initial version",
      upgradeAttributes: (old) => ({ ...old, added: true }),
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, false);
  assertEquals(result.definition.globalArguments.message, "hello");
  assertEquals(result.definition.globalArguments.added, undefined);
});

Deno.test("DefinitionUpgradeService - no upgrade needed when no upgrades defined", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.01.15.1",
    globalArguments: { message: "hello" },
  });

  const modelDef = createModelDef("2025.06.01.1");

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, false);
});

Deno.test("DefinitionUpgradeService - single-step upgrade", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.01.15.1",
    globalArguments: { message: "hello" },
  });

  const modelDef = createModelDef("2025.06.01.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field",
      upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, true);
  assertEquals(result.definition.globalArguments.message, "hello");
  assertEquals(result.definition.globalArguments.priority, "medium");
  assertEquals(result.definition.typeVersion, "2025.06.01.1");
  assertEquals(result.fromVersion, "2025.01.15.1");
  assertEquals(result.toVersion, "2025.06.01.1");
});

Deno.test("DefinitionUpgradeService - multi-step upgrade chain", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.01.15.1",
    globalArguments: { message: "hello" },
  });

  const modelDef = createModelDef("2026.02.09.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field",
      upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename message to content",
      upgradeAttributes: (old) => {
        const { message, ...rest } = old;
        return { ...rest, content: message };
      },
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, true);
  assertEquals(result.definition.globalArguments.content, "hello");
  assertEquals(result.definition.globalArguments.priority, "medium");
  assertEquals(result.definition.globalArguments.message, undefined);
  assertEquals(result.definition.typeVersion, "2026.02.09.1");
});

Deno.test("DefinitionUpgradeService - undefined typeVersion triggers full upgrade chain", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    globalArguments: { message: "hello" },
  });

  // typeVersion is undefined (legacy pre-CalVer definition)
  assertEquals(definition.typeVersion, undefined);

  const modelDef = createModelDef("2026.02.09.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field",
      upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename message to content",
      upgradeAttributes: (old) => {
        const { message, ...rest } = old;
        return { ...rest, content: message };
      },
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, true);
  assertEquals(result.definition.globalArguments.content, "hello");
  assertEquals(result.definition.globalArguments.priority, "medium");
  assertEquals(result.definition.typeVersion, "2026.02.09.1");
  assertEquals(result.fromVersion, undefined);
});

Deno.test("DefinitionUpgradeService - partial upgrade (skip already applied)", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.06.01.1",
    globalArguments: { message: "hello", priority: "medium" },
  });

  const modelDef = createModelDef("2026.02.09.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field",
      upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename message to content",
      upgradeAttributes: (old) => {
        const { message, ...rest } = old;
        return { ...rest, content: message };
      },
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, true);
  // Only the second upgrade should have been applied
  assertEquals(result.definition.globalArguments.content, "hello");
  assertEquals(result.definition.globalArguments.priority, "medium");
  assertEquals(result.definition.globalArguments.message, undefined);
  assertEquals(result.definition.typeVersion, "2026.02.09.1");
});

Deno.test("DefinitionUpgradeService - preserves id, name, tags", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "my-definition",
    type: "test/upgradeable",
    typeVersion: "2025.01.15.1",
    tags: { env: "prod", team: "platform" },
    globalArguments: { message: "hello" },
  });

  const modelDef = createModelDef("2025.06.01.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority",
      upgradeAttributes: (old) => ({ ...old, priority: "high" }),
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, true);
  assertEquals(result.definition.id, "550e8400-e29b-41d4-a716-446655440000");
  assertEquals(result.definition.name, "my-definition");
  assertEquals(result.definition.tags, { env: "prod", team: "platform" });
  assertEquals(result.definition.type, "test/upgradeable");
});

Deno.test("DefinitionUpgradeService - legacy numeric typeVersion coerced to undefined", () => {
  const service = new DefinitionUpgradeService();
  // Simulate a definition loaded from disk with numeric typeVersion
  const definition = Definition.fromData({
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "legacy-def",
    version: 1,
    type: "test/upgradeable",
    typeVersion: 1 as unknown as string, // numeric typeVersion from disk
    tags: {},
    globalArguments: { message: "old" },
    methods: {},
    inputs: undefined,
  });

  // After preprocess, typeVersion should be undefined
  assertEquals(definition.typeVersion, undefined);

  const modelDef = createModelDef("2025.06.01.1", [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority",
      upgradeAttributes: (old) => ({ ...old, priority: "low" }),
    },
  ]);

  const result = service.upgrade(definition, modelDef);

  assertEquals(result.upgraded, true);
  assertEquals(result.definition.globalArguments.priority, "low");
  assertEquals(result.definition.typeVersion, "2025.06.01.1");
});
