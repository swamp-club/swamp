import { assertEquals } from "@std/assert";
import { z } from "zod";
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
    inputAttributesSchema: z.object({}),
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
    attributes: { message: "hello" },
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
  assertEquals(result.definition.attributes.message, "hello");
  assertEquals(result.definition.attributes.added, undefined);
});

Deno.test("DefinitionUpgradeService - no upgrade needed when no upgrades defined", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.01.15.1",
    attributes: { message: "hello" },
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
    attributes: { message: "hello" },
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
  assertEquals(result.definition.attributes.message, "hello");
  assertEquals(result.definition.attributes.priority, "medium");
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
    attributes: { message: "hello" },
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
  assertEquals(result.definition.attributes.content, "hello");
  assertEquals(result.definition.attributes.priority, "medium");
  assertEquals(result.definition.attributes.message, undefined);
  assertEquals(result.definition.typeVersion, "2026.02.09.1");
});

Deno.test("DefinitionUpgradeService - undefined typeVersion triggers full upgrade chain", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    attributes: { message: "hello" },
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
  assertEquals(result.definition.attributes.content, "hello");
  assertEquals(result.definition.attributes.priority, "medium");
  assertEquals(result.definition.typeVersion, "2026.02.09.1");
  assertEquals(result.fromVersion, undefined);
});

Deno.test("DefinitionUpgradeService - partial upgrade (skip already applied)", () => {
  const service = new DefinitionUpgradeService();
  const definition = Definition.create({
    name: "test-def",
    type: "test/upgradeable",
    typeVersion: "2025.06.01.1",
    attributes: { message: "hello", priority: "medium" },
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
  assertEquals(result.definition.attributes.content, "hello");
  assertEquals(result.definition.attributes.priority, "medium");
  assertEquals(result.definition.attributes.message, undefined);
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
    attributes: { message: "hello" },
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
    attributes: { message: "old" },
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
  assertEquals(result.definition.attributes.priority, "low");
  assertEquals(result.definition.typeVersion, "2025.06.01.1");
});
