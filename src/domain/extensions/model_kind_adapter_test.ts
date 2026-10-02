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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  clearAttachedExtensions,
  detachExtensionSources,
  getExtensionMemberCollisions,
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "./model_kind_adapter.ts";
import { basename, join } from "@std/path";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import {
  canonicalizePath,
  realCanonicalPath,
} from "../../infrastructure/persistence/canonicalize_path.ts";
import { ModelType } from "../models/model_type.ts";
import type { ExtensionContributor } from "./extension_precedence.ts";
import { modelRegistry } from "../models/model.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";

Deno.test("removeAttachedExtensionsForType: does not throw for unknown type", () => {
  removeAttachedExtensionsForType("@nonexistent/type");
});

Deno.test("removeAttachedExtensionsForType: clears only the targeted type", () => {
  clearAttachedExtensions();
  removeAttachedExtensionsForType("@test/alpha");
  removeAttachedExtensionsForType("@test/beta");
});

Deno.test("extractTypeFromSource: standalone model returns kind=model", () => {
  const source = `
import { z } from "npm:zod";
export const model = {
  type: "@test/greeter",
  version: "2026.01.01.0",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("extractTypeFromSource: extension returns kind=extension", () => {
  const source = `
import { z } from "npm:zod";
export const extension = {
  type: "@test/greeter",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "extension");
  assertEquals(result?.extendsType, "@test/greeter");
});

Deno.test("extractTypeFromSource: model with 'export const extension' in comment returns kind=model", () => {
  const source = `
import { z } from "npm:zod";
// NOTE: use export const extension = {...} to extend an existing type
export const model = {
  type: "@test/greeter",
  version: "2026.01.01.0",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("extractTypeFromSource: model with 'export const extension' in string returns kind=model", () => {
  const source = `
import { z } from "npm:zod";
export const model = {
  type: "@test/greeter",
  version: "2026.01.01.0",
  methods: {
    greet: {
      description: "Use export const extension = {...} to extend types.",
    },
  },
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("extractTypeFromSource: model with inline structural type annotation extracts type and version", () => {
  const source = `
import { z } from "npm:zod";
export const model: {
  type: string;
  version: string;
  resources: Record<string, {
    nested: { deep: true };
  }>;
} = {
  type: "@test/greeter",
  version: "2026.01.01.0",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.typeNormalized, "@test/greeter");
  assertEquals(result?.version, "2026.01.01.0");
  assertEquals(result?.kind, "model");
  assertEquals(result?.extendsType, "");
});

Deno.test("extractTypeFromSource: extension with inline type annotation extracts type", () => {
  const source = `
import { z } from "npm:zod";
export const extension: {
  type: string;
} = {
  type: "@test/greeter",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.typeNormalized, "@test/greeter");
  assertEquals(result?.kind, "extension");
  assertEquals(result?.extendsType, "@test/greeter");
});

Deno.test("extractTypeFromSource: model with simple named type annotation extracts type", () => {
  const source = `
import { z } from "npm:zod";
export const model: ModelDefinition = {
  type: "@test/greeter",
  version: "2026.01.01.0",
};`;
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.typeNormalized, "@test/greeter");
  assertEquals(result?.version, "2026.01.01.0");
  assertEquals(result?.kind, "model");
});

Deno.test("importAndExtendBundle: skips standalone model bundle without throwing", async () => {
  const entry = {
    source_path: "/tmp/fake/model.ts",
    type_normalized: "@test/greeter",
    kind: "extension" as const,
    bundle_path: "/tmp/fake/model.js",
    version: "1.0.0",
    description: "",
    extends_type: "@test/greeter",
    source_mtime: "",
    source_fingerprint: "",
  };
  const result = {
    loaded: [] as string[],
    extended: [] as string[],
    failed: [] as { file: string; error: string }[],
  };
  await modelKindAdapter.importAndExtendBundle!(
    entry,
    () => Promise.resolve({ model: { type: "@test/greeter" } }),
    result,
    localContributor(entry.source_path),
  );
  assertEquals(result.extended.length, 0);
  assertEquals(result.failed.length, 0);
});

Deno.test("importAndExtendBundle: throws for bundle with neither model nor extension export", async () => {
  const entry = {
    source_path: "/tmp/fake/broken.ts",
    type_normalized: "@test/broken",
    kind: "extension" as const,
    bundle_path: "/tmp/fake/broken.js",
    version: "1.0.0",
    description: "",
    extends_type: "@test/broken",
    source_mtime: "",
    source_fingerprint: "",
  };
  const result = {
    loaded: [] as string[],
    extended: [] as string[],
    failed: [] as { file: string; error: string }[],
  };
  await assertRejects(
    () =>
      modelKindAdapter.importAndExtendBundle!(
        entry,
        () => Promise.resolve({ helper: true }),
        result,
        localContributor(entry.source_path),
      ),
    Error,
    "Bundle has no extension export",
  );
});

// ── validatePrimaryExport: upgrade chain consistency ─────────────────

const fakeZodSchema = {
  _def: {},
  parse: () => ({}),
  safeParse: () => ({ success: true, data: {} }),
};

function makeValidModel(overrides: Record<string, unknown> = {}) {
  return {
    type: "@test/greeter",
    version: "2026.01.01.1",
    methods: {
      greet: {
        description: "Say hello",
        arguments: fakeZodSchema,
        execute: () => Promise.resolve({ message: "hi" }),
      },
    },
    ...overrides,
  };
}

Deno.test("validatePrimaryExport: model without upgrades passes", () => {
  const result = modelKindAdapter.validatePrimaryExport(makeValidModel());
  assertEquals(result.success, true);
});

Deno.test("validatePrimaryExport: model with empty upgrades passes", () => {
  const result = modelKindAdapter.validatePrimaryExport(
    makeValidModel({ upgrades: [] }),
  );
  assertEquals(result.success, true);
});

Deno.test("validatePrimaryExport: model with matching last toVersion passes", () => {
  const result = modelKindAdapter.validatePrimaryExport(
    makeValidModel({
      version: "2026.03.28.2",
      upgrades: [
        {
          toVersion: "2026.01.01.1",
          description: "Initial",
          upgradeAttributes: (old: Record<string, unknown>) => old,
        },
        {
          toVersion: "2026.03.28.2",
          description: "Latest",
          upgradeAttributes: (old: Record<string, unknown>) => old,
        },
      ],
    }),
  );
  assertEquals(result.success, true);
});

Deno.test("validatePrimaryExport: model with mismatching last toVersion fails", () => {
  const result = modelKindAdapter.validatePrimaryExport(
    makeValidModel({
      version: "2026.07.16.2",
      upgrades: [
        {
          toVersion: "2026.03.28.2",
          description: "Old upgrade",
          upgradeAttributes: (old: Record<string, unknown>) => old,
        },
      ],
    }),
  );
  assertEquals(result.success, false);
});

// ── processSecondaryExport: method collision pre-filtering ─────────────

function localContributor(sourcePath: string): ExtensionContributor {
  return { sourcePath, pulled: false };
}

const testArgs = z.object({});

function registerTestModel(
  type: string,
  methods: Record<string, unknown>,
): void {
  modelRegistry.register({
    type: ModelType.create(type),
    version: "2026.01.01.0",
    methods: Object.fromEntries(
      Object.entries(methods).map(([name, _]) => [
        name,
        {
          description: `Base ${name}`,
          arguments: testArgs,
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      ]),
    ),
  });
}

function makeExtension(
  type: string,
  methodNames: string[],
): Record<string, unknown> {
  return {
    type,
    methods: methodNames.map((name) => ({
      [name]: {
        description: `Extension ${name}`,
        arguments: testArgs,
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    })),
  };
}

Deno.test("processSecondaryExport: an extension targeting a control-plane type fails and attaches nothing", () => {
  for (const type of ["swamp/grant", "@swamp/grant", "swamp/worker"]) {
    const registered = modelRegistry.has(type);
    if (!registered) registerTestModel(type, { list: true });
    const before = Object.keys(modelRegistry.get(type)?.methods ?? {});
    try {
      const result = {
        loaded: [] as string[],
        extended: [] as string[],
        failed: [] as { file: string; error: string }[],
      };
      modelKindAdapter.processSecondaryExport!(
        "extensions/models/sneaky.ts",
        makeExtension(type, ["sneaky"]),
        result,
        localContributor("/repo/extensions/models/sneaky.ts"),
      );

      assertEquals(result.extended, []);
      assertEquals(result.failed, [{
        file: "extensions/models/sneaky.ts",
        error: `Cannot extend control-plane model type: ${type}`,
      }]);
      assertEquals(Object.keys(modelRegistry.get(type)?.methods ?? {}), before);
    } finally {
      if (!registered) modelRegistry.invalidateType(type);
    }
  }
});

Deno.test("processSecondaryExport: colliding method is skipped, sibling is merged", () => {
  const type = "@test/collision-partial";
  resetExtensionLoadWarnings();
  registerTestModel(type, { retrieve: true });
  try {
    const result = {
      loaded: [] as string[],
      extended: [] as string[],
      failed: [] as { file: string; error: string }[],
    };
    modelKindAdapter.processSecondaryExport!(
      "extensions/models/probe.ts",
      makeExtension(type, ["retrieve", "probe_marker"]),
      result,
      localContributor("/repo/extensions/models/probe.ts"),
    );

    assertEquals(result.extended, ["extensions/models/probe.ts"]);
    assertEquals(result.failed.length, 0);

    const model = modelRegistry.get(type);
    assertEquals("probe_marker" in (model?.methods ?? {}), true);
    assertEquals(model?.methods["retrieve"]?.description, "Base retrieve");

    const warnings = getExtensionLoadWarnings();
    const collision = warnings.find((w) =>
      w.error.includes("retrieve") && w.error.includes("already exists")
    );
    assertEquals(collision !== undefined, true);
  } finally {
    modelRegistry.invalidateType(type);
    resetExtensionLoadWarnings();
  }
});

Deno.test("processSecondaryExport: all methods collide — file marked extended, warnings emitted", () => {
  const type = "@test/collision-full";
  resetExtensionLoadWarnings();
  registerTestModel(type, { run: true, list: true });
  try {
    const result = {
      loaded: [] as string[],
      extended: [] as string[],
      failed: [] as { file: string; error: string }[],
    };
    modelKindAdapter.processSecondaryExport!(
      "extensions/models/dupe.ts",
      makeExtension(type, ["run", "list"]),
      result,
      localContributor("/repo/extensions/models/dupe.ts"),
    );

    assertEquals(result.extended, ["extensions/models/dupe.ts"]);
    assertEquals(result.failed.length, 0);

    const warnings = getExtensionLoadWarnings();
    assertEquals(
      warnings.filter((w) => w.error.includes("already exists")).length,
      2,
    );
  } finally {
    modelRegistry.invalidateType(type);
    resetExtensionLoadWarnings();
  }
});

Deno.test("processSecondaryExport: no collision — all methods merged normally", () => {
  const type = "@test/no-collision";
  resetExtensionLoadWarnings();
  registerTestModel(type, { run: true });
  try {
    const result = {
      loaded: [] as string[],
      extended: [] as string[],
      failed: [] as { file: string; error: string }[],
    };
    modelKindAdapter.processSecondaryExport!(
      "extensions/models/clean.ts",
      makeExtension(type, ["custom_method"]),
      result,
      localContributor("/repo/extensions/models/clean.ts"),
    );

    assertEquals(result.extended, ["extensions/models/clean.ts"]);
    assertEquals(result.failed.length, 0);

    const model = modelRegistry.get(type);
    assertEquals("custom_method" in (model?.methods ?? {}), true);

    const warnings = getExtensionLoadWarnings();
    assertEquals(
      warnings.filter((w) => w.error.includes("already exists")).length,
      0,
    );
  } finally {
    modelRegistry.invalidateType(type);
    resetExtensionLoadWarnings();
  }
});

// ── processSecondaryExport: extension-vs-extension precedence (#2562) ──

const LOCAL_AA = "/repo/extensions/models/aa_ext.ts";
const LOCAL_ZZ = "/repo/extensions/models/zz_ext.ts";
const PULLED = "/repo/.swamp/pulled-extensions/@acme/pkg/models/probe.ts";

function contributorAt(sourcePath: string): ExtensionContributor {
  return { sourcePath, pulled: sourcePath.includes("/pulled-extensions/") };
}

function labelledExtension(
  type: string,
  label: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    methods: [{
      probe: {
        description: `probe from ${label}`,
        arguments: testArgs,
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    }],
    ...extra,
  };
}

function newResult() {
  return {
    loaded: [] as string[],
    extended: [] as string[],
    failed: [] as { file: string; error: string }[],
  };
}

function attach(
  type: string,
  sourcePath: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  const result = newResult();
  modelKindAdapter.processSecondaryExport!(
    sourcePath,
    labelledExtension(type, label, extra),
    result,
    contributorAt(sourcePath),
  );
  return result;
}

function probeDescription(type: string): string | undefined {
  return modelRegistry.get(type)?.methods["probe"]?.description;
}

function withPrecedenceType(fn: (type: string) => void): void {
  const type = `@test/precedence-${crypto.randomUUID().slice(0, 8)}`;
  resetExtensionLoadWarnings();
  registerTestModel(type, { get: true });
  try {
    fn(type);
  } finally {
    modelRegistry.invalidateType(type);
    removeAttachedExtensionsForType(type);
    resetExtensionLoadWarnings();
  }
}

Deno.test("processSecondaryExport: local beats pulled in either attach order", () => {
  for (const order of [[PULLED, LOCAL_ZZ], [LOCAL_ZZ, PULLED]]) {
    withPrecedenceType((type) => {
      for (const path of order) attach(type, path, path);
      assertEquals(probeDescription(type), `probe from ${LOCAL_ZZ}`);
      const [collision] = getExtensionMemberCollisions().filter((c) =>
        c.type === type
      );
      assertEquals(collision.winner, LOCAL_ZZ);
      assertEquals(collision.losers, [PULLED]);
    });
  }
});

Deno.test("processSecondaryExport: within one origin the smaller path wins in either order", () => {
  for (const order of [[LOCAL_ZZ, LOCAL_AA], [LOCAL_AA, LOCAL_ZZ]]) {
    withPrecedenceType((type) => {
      for (const path of order) attach(type, path, path);
      assertEquals(probeDescription(type), `probe from ${LOCAL_AA}`);
    });
  }
});

Deno.test("processSecondaryExport: a base-model member always wins over extensions", () => {
  withPrecedenceType((type) => {
    modelRegistry.invalidateType(type);
    registerTestModel(type, { get: true, probe: true });
    attach(type, LOCAL_AA, "aa");
    assertEquals(probeDescription(type), "Base probe");
    const [collision] = getExtensionMemberCollisions().filter((c) =>
      c.type === type
    );
    assertEquals(collision.winner, null);
    assertEquals(collision.losers, [LOCAL_AA]);
  });
});

Deno.test("processSecondaryExport: member names shared with Object.prototype are added, not treated as base collisions", () => {
  withPrecedenceType((type) => {
    const result = newResult();
    modelKindAdapter.processSecondaryExport!(
      LOCAL_AA,
      makeExtension(type, ["toString", "constructor"]),
      result,
      contributorAt(LOCAL_AA),
    );
    assertEquals(result.failed, []);
    const methods = modelRegistry.get(type)!.methods;
    assertEquals(Object.hasOwn(methods, "toString"), true);
    assertEquals(Object.hasOwn(methods, "constructor"), true);
    assertEquals(
      getExtensionMemberCollisions().filter((c) => c.type === type),
      [],
    );
  });
});

Deno.test("processSecondaryExport: stale provenance never lets an extension replace a re-registered base member", () => {
  withPrecedenceType((type) => {
    attach(type, PULLED, "pulled");
    // The type is re-registered with its own `probe`, without clearing the
    // attach record (e.g. an invalidation path that skips it).
    modelRegistry.invalidateType(type);
    registerTestModel(type, { get: true, probe: true });
    attach(type, LOCAL_AA, "local");
    assertEquals(probeDescription(type), "Base probe");
  });
});

Deno.test("processSecondaryExport: a re-attaching source replaces its own member silently", () => {
  withPrecedenceType((type) => {
    attach(type, LOCAL_AA, "aa v1");
    const result = attach(type, LOCAL_AA, "aa v2");
    assertEquals(result.failed.length, 0);
    assertEquals(probeDescription(type), "probe from aa v2");
    assertEquals(
      getExtensionLoadWarnings().filter((w) => w.category === "MemberCollision")
        .length,
      0,
    );
    assertEquals(
      getExtensionMemberCollisions().filter((c) => c.type === type).length,
      0,
    );
  });
});

Deno.test("processSecondaryExport: collision warnings name both files and the winner", () => {
  withPrecedenceType((type) => {
    attach(type, PULLED, "pulled");
    attach(type, LOCAL_ZZ, "local");
    attach(type, LOCAL_AA.replace("aa_ext", "zzz_ext"), "later local");
    const messages = getExtensionLoadWarnings()
      .filter((w) => w.category === "MemberCollision")
      .map((w) => `${w.file}: ${w.error}`);
    assertEquals(messages.length, 2);
    assertStringIncludes(messages[0], LOCAL_ZZ);
    assertStringIncludes(messages[0], `overrides the one from ${PULLED}`);
    assertStringIncludes(messages[0], "local beats pulled");
    assertStringIncludes(
      messages[1],
      `also provided by ${LOCAL_ZZ}, which wins`,
    );
    assertStringIncludes(messages[1], "the alphabetically first path wins");
  });
});

Deno.test("processSecondaryExport: checks and resources follow the same precedence", () => {
  withPrecedenceType((type) => {
    const extra = (label: string) => ({
      checks: [{
        policy: {
          description: `policy from ${label}`,
          execute: () => Promise.resolve({ pass: true }),
        },
      }],
      resources: {
        audit: {
          description: `audit from ${label}`,
          schema: z.object({}),
          lifetime: "infinite",
          garbageCollection: 1,
        },
      },
    });
    attach(type, PULLED, "pulled", extra("pulled"));
    attach(type, LOCAL_AA, "local", extra("local"));
    const model = modelRegistry.get(type)!;
    assertEquals(model.checks?.["policy"]?.description, "policy from local");
    assertEquals(model.resources?.["audit"]?.description, "audit from local");
  });
});

Deno.test("processSecondaryExport: a failed registry merge leaves provenance unchanged", () => {
  withPrecedenceType((type) => {
    attach(type, PULLED, "pulled");
    const original = modelRegistry.applyExtensionMembers;
    modelRegistry.applyExtensionMembers = () => {
      throw new Error("merge failed");
    };
    let failed;
    try {
      failed = attach(type, LOCAL_AA, "local");
    } finally {
      modelRegistry.applyExtensionMembers = original;
    }
    assertEquals(failed.failed.length, 1);
    assertEquals(probeDescription(type), "probe from pulled");
    // The pulled file still owns the member, so a lower-ranked pulled
    // source is refused rather than treated as overriding a base member.
    attach(type, PULLED.replace("probe.ts", "zz.ts"), "pulled zz");
    assertEquals(probeDescription(type), "probe from pulled");
    const [collision] = getExtensionMemberCollisions().filter((c) =>
      c.type === type
    );
    assertEquals(collision.winner, PULLED);
  });
});

// ── attachPendingExtensionsForType: files that add nothing (#2562) ────

for (
  const [label, exported] of [
    ["an extension with no members", "empty"],
    ["a standalone model bundle cataloged as an extension", "model"],
  ] as const
) {
  Deno.test(`attachPendingExtensionsForType: ${label} is imported once, not on every pass`, async () => {
    const type = `@test/noop-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await Deno.makeTempDir({ prefix: "swamp_2562_noop_" });
    const catalog = new ExtensionCatalogStore(join(dir, "catalog.db"));
    clearAttachedExtensions();
    registerTestModel(type, { get: true });
    // Rows whose source is missing are dropped (swamp-club#2490).
    await Deno.writeTextFile(join(dir, "noop.ts"), "");
    try {
      catalog.upsert({
        source_path: join(dir, "noop.ts"),
        type_normalized: type,
        kind: "extension",
        bundle_path: join(dir, "noop.js"),
        version: "",
        description: "",
        extends_type: type,
        source_mtime: "",
        source_fingerprint: "fp-noop",
      });
      let imports = 0;
      const importFn = () => {
        imports++;
        return Promise.resolve(
          exported === "empty"
            ? { extension: { type, methods: [] } }
            : { model: { type } },
        );
      };
      for (let pass = 0; pass < 3; pass++) {
        await modelKindAdapter.attachPendingExtensionsForType!(
          type,
          catalog,
          importFn,
          localContributor,
        );
      }
      assertEquals(imports, 1);
    } finally {
      catalog.close();
      clearAttachedExtensions();
      modelRegistry.invalidateType(type);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}

// ── attachPendingExtensionsForType: per-extension isolation ────────────

Deno.test("attachPendingExtensionsForType: an extension that fails to import is skipped, the rest attach, and it is retried (swamp-club#2557)", async () => {
  const type = `@test/isolate-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir({ prefix: "swamp_2557_attach_" });
  const catalog = new ExtensionCatalogStore(join(dir, "catalog.db"));
  clearAttachedExtensions();
  registerTestModel(type, { get: true });
  try {
    for (const name of ["broken", "good"]) {
      await Deno.writeTextFile(join(dir, `${name}.ts`), "");
      catalog.upsert({
        source_path: join(dir, `${name}.ts`),
        type_normalized: type,
        kind: "extension",
        bundle_path: join(dir, `${name}.js`),
        version: "",
        description: "",
        extends_type: type,
        source_mtime: "",
        source_fingerprint: `fp-${name}`,
      });
    }

    let brokenFails = true;
    const importFn = (paths: { bundlePath: string }) => {
      const name = basename(paths.bundlePath, ".js");
      if (name === "broken" && brokenFails) {
        return Promise.reject(new Error("bundle import failed"));
      }
      return Promise.resolve({
        extension: makeExtension(type, [`${name}_method`]),
      });
    };

    await modelKindAdapter.attachPendingExtensionsForType!(
      type,
      catalog,
      importFn,
      localContributor,
    );
    const afterFirst = modelRegistry.get(type)?.methods ?? {};
    assertEquals("good_method" in afterFirst, true);
    assertEquals("broken_method" in afterFirst, false);

    // The failed extension was not marked attached, so a later pass
    // attaches it once its bundle imports.
    brokenFails = false;
    await modelKindAdapter.attachPendingExtensionsForType!(
      type,
      catalog,
      importFn,
      localContributor,
    );
    assertEquals(
      "broken_method" in (modelRegistry.get(type)?.methods ?? {}),
      true,
    );
  } finally {
    catalog.close();
    clearAttachedExtensions();
    modelRegistry.invalidateType(type);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── detachExtensionSources: removed extensions leave a type (#2745) ──

Deno.test("detachExtensionSources: removes only the removed source's members", () => {
  withPrecedenceType((type) => {
    attach(type, LOCAL_AA, "aa", {
      checks: [{
        aa_check: {
          description: "aa check",
          execute: () => Promise.resolve({ pass: true }),
        },
      }],
    });
    modelKindAdapter.processSecondaryExport!(
      PULLED,
      {
        type,
        methods: [{
          probe: {
            description: "probe from pulled",
            arguments: testArgs,
            execute: () => Promise.resolve({ dataHandles: [] }),
          },
          pulled_only: {
            description: "pulled only",
            arguments: testArgs,
            execute: () => Promise.resolve({ dataHandles: [] }),
          },
        }],
      },
      newResult(),
      contributorAt(PULLED),
    );
    assertEquals(
      Object.hasOwn(modelRegistry.get(type)!.methods, "pulled_only"),
      true,
    );

    assertEquals(detachExtensionSources(type, (p) => p === PULLED), true);

    const after = modelRegistry.get(type)!;
    assertEquals(Object.hasOwn(after.methods, "pulled_only"), false);
    assertEquals(probeDescription(type), `probe from ${"aa"}`);
    assertEquals(after.methods.get.description, "Base get");
    assertEquals(after.checks!.aa_check.description, "aa check");
    assertEquals(
      getExtensionMemberCollisions().filter((c) => c.type === type),
      [],
      "the removed loser leaves the collision listing",
    );
  });
});

Deno.test("detachExtensionSources: never removes a base member of the same name", () => {
  withPrecedenceType((type) => {
    modelRegistry.invalidateType(type);
    registerTestModel(type, { get: true, probe: true });
    attach(type, LOCAL_AA, "aa");

    assertEquals(detachExtensionSources(type, (p) => p === LOCAL_AA), true);

    assertEquals(probeDescription(type), "Base probe");
    assertEquals(
      getExtensionMemberCollisions().filter((c) => c.type === type),
      [],
    );
  });
});

Deno.test("detachExtensionSources: is a no-op for a type with nothing attached", () => {
  const type = `@test/detach-none-${crypto.randomUUID().slice(0, 8)}`;
  assertEquals(detachExtensionSources(type, () => true), false);
});

Deno.test("detachExtensionSources: a member displaced by the removed source attaches again, under a symlinked repo root", async () => {
  const type = `@test/detach-loser-${crypto.randomUUID().slice(0, 8)}`;
  const realDir = await Deno.makeTempDir({ prefix: "swamp_2745_detach_" });
  const linkDir = `${realDir}-link`;
  await Deno.symlink(realDir, linkDir, { type: "dir" });
  const catalog = new ExtensionCatalogStore(join(realDir, "catalog.db"));
  resetExtensionLoadWarnings();
  registerTestModel(type, { get: true });
  try {
    // Catalog rows spell the repo through the symlink, as a serve started
    // from that path would; contributors are symlink-resolved.
    const winner = canonicalizePath(join(linkDir, "aa_winner.ts"));
    const loser = canonicalizePath(join(linkDir, "zz_loser.ts"));
    for (const [sourcePath, label] of [[winner, "winner"], [loser, "loser"]]) {
      await Deno.writeTextFile(sourcePath, "");
      catalog.upsert({
        source_path: sourcePath,
        type_normalized: type,
        kind: "extension",
        bundle_path: `${sourcePath}.js`,
        version: "",
        description: "",
        extends_type: type,
        source_mtime: "",
        source_fingerprint: `fp-${label}`,
      });
    }
    const labels = new Map([[winner, "winner"], [loser, "loser"]]);
    const imports: string[] = [];
    const importFn = (paths: { sourcePath: string }) => {
      imports.push(paths.sourcePath);
      return Promise.resolve({
        extension: labelledExtension(type, labels.get(paths.sourcePath)!),
      });
    };
    const contributorFor = (sourcePath: string) =>
      localContributor(realCanonicalPath(sourcePath));
    const attachPass = () =>
      modelKindAdapter.attachPendingExtensionsForType!(
        type,
        catalog,
        importFn,
        contributorFor,
      );

    await attachPass();
    assertEquals(probeDescription(type), "probe from winner");

    catalog.removeByRawSourcePath(winner);
    await Deno.remove(winner);
    const removed = realCanonicalPath(realDir) + "/aa_winner.ts";
    assertEquals(
      detachExtensionSources(
        type,
        (p) => p === winner || p === removed,
      ),
      true,
    );
    assertEquals(probeDescription(type), undefined);

    imports.length = 0;
    await attachPass();
    assertEquals(imports, [loser], "only the freed loser is processed again");
    assertEquals(probeDescription(type), "probe from loser");
    assertEquals(
      getExtensionMemberCollisions().filter((c) => c.type === type),
      [],
    );
  } finally {
    modelRegistry.invalidateType(type);
    removeAttachedExtensionsForType(type);
    resetExtensionLoadWarnings();
    catalog.close();
    await Deno.remove(linkDir);
    if (Deno.build.os === "windows") {
      await Deno.remove(realDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(realDir, { recursive: true });
    }
  }
});

// ── Extension rows whose source is gone (swamp-club#2490) ──────────────

/**
 * Seeds three extension rows for `type`: `live` (source on disk, bundle
 * live.js), `gone` (source missing, own bundle gone.js) and `shared`
 * (source missing, but its bundle path is live.js). Every bundle file
 * exists.
 */
async function seedStaleExtensionRows(
  dir: string,
  catalog: ExtensionCatalogStore,
  type: string,
): Promise<void> {
  await Deno.writeTextFile(join(dir, "live.ts"), "");
  await Deno.writeTextFile(join(dir, "live.js"), "");
  await Deno.writeTextFile(join(dir, "gone.js"), "");
  for (
    const [name, bundle] of [
      ["live", "live.js"],
      ["gone", "gone.js"],
      ["shared", "live.js"],
    ]
  ) {
    catalog.upsert({
      source_path: join(dir, `${name}.ts`),
      type_normalized: type,
      kind: "extension",
      bundle_path: join(dir, bundle),
      version: "",
      description: "",
      extends_type: type,
      source_mtime: "",
      source_fingerprint: `fp-${name}`,
    });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("findExtensionsForType: drops rows whose source is gone and evicts their unshared bundles (swamp-club#2490)", async () => {
  const type = `@test/stale-ext-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir({ prefix: "swamp_2490_ext_" });
  const catalog = new ExtensionCatalogStore(join(dir, "catalog.db"));
  try {
    await seedStaleExtensionRows(dir, catalog, type);

    const rows = modelKindAdapter.findExtensionsForType!(catalog, type);

    assertEquals(rows.map((r) => basename(r.source_path)), ["live.ts"]);
    assertEquals(
      catalog.findExtensionsForType(type).map((r) => basename(r.source_path)),
      ["live.ts"],
    );
    // gone.js belonged only to a removed row; live.js is still referenced
    // by the live row even though the removed `shared` row named it too.
    assertEquals(await fileExists(join(dir, "gone.js")), false);
    assertEquals(await fileExists(join(dir, "live.js")), true);
  } finally {
    catalog.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("attachPendingExtensionsForType: never imports a row whose source is gone (swamp-club#2490)", async () => {
  const type = `@test/stale-attach-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir({ prefix: "swamp_2490_attach_" });
  const catalog = new ExtensionCatalogStore(join(dir, "catalog.db"));
  clearAttachedExtensions();
  registerTestModel(type, { get: true });
  try {
    await seedStaleExtensionRows(dir, catalog, type);

    const imported: string[] = [];
    const importFn = (paths: { sourcePath: string }) => {
      const name = basename(paths.sourcePath, ".ts");
      imported.push(name);
      return Promise.resolve({
        extension: makeExtension(type, [`${name}_method`]),
      });
    };
    await modelKindAdapter.attachPendingExtensionsForType!(
      type,
      catalog,
      importFn,
      localContributor,
    );

    assertEquals(imported, ["live"]);
    assertEquals(
      catalog.findExtensionsForType(type).map((r) => basename(r.source_path)),
      ["live.ts"],
    );
    assertEquals(await fileExists(join(dir, "gone.js")), false);
  } finally {
    catalog.close();
    clearAttachedExtensions();
    modelRegistry.invalidateType(type);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// --- formatValidationError tests ---

Deno.test("formatValidationError: missing execute reports method name", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods", "create", "execute"],
      message: "Invalid input",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "'execute'");
  assertStringIncludes(result, "'create'");
  assertStringIncludes(result, "async function");
});

Deno.test("formatValidationError: invalid kind reports method name and allowed values", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods", "connect", "kind"],
      message: "Invalid enum value",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "'kind'");
  assertStringIncludes(result, "'connect'");
  assertStringIncludes(result, "create, read, update, delete, list, action");
});

Deno.test("formatValidationError: missing description reports method name", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods", "run", "description"],
      message: "Required",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "'description'");
  assertStringIncludes(result, "'run'");
});

Deno.test("formatValidationError: truly missing methods still reports missing field", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods"],
      message: "Required",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "Missing required 'methods' field");
});

Deno.test("formatValidationError: extension schema execute path reports method name", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods", 0, "create", "execute"],
      message: "Invalid input",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "'execute'");
  assertStringIncludes(result, "'create'");
});

Deno.test("formatValidationError: unknown method sub-field includes path", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods", "run", "unknownField"],
      message: "Unexpected field",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "methods.run.unknownField");
  assertStringIncludes(result, "Unexpected field");
});

Deno.test("formatValidationError: arguments on method includes method name", () => {
  const error = new z.ZodError([
    {
      code: "custom",
      path: ["methods", "deploy", "arguments"],
      message: "Invalid input",
    },
  ]);
  const result = modelKindAdapter.formatValidationError(error);
  assertStringIncludes(result, "'arguments'");
  assertStringIncludes(result, "'deploy'");
});

Deno.test("extractTypeFromSource: model declared only in a template fixture returns null (swamp-club#2876)", () => {
  const source = [
    "const fixture = `export const model = {",
    '  type: "@acme/thing",',
    '  version: "1",',
    "};`;",
    'Deno.test("extracts the type", () => {});',
  ].join("\n");
  assertEquals(modelKindAdapter.extractTypeFromSource(source), null);
});

Deno.test("extractTypeFromSource: reads the real model after a string fixture", () => {
  const source = [
    "const fixture = \"export const model = { type: '@acme/thing', version: '9' }\";",
    "export const model = {",
    '  type: "@test/greeter",',
    '  version: "2026.01.01.0",',
    "};",
  ].join("\n");
  const result = modelKindAdapter.extractTypeFromSource(source);
  assertEquals(result?.typeNormalized, "@test/greeter");
  assertEquals(result?.version, "2026.01.01.0");
  assertEquals(result?.kind, "model");
});
