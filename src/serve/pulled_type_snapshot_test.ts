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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  capturePulledTypes,
  isBuiltInType,
  unregisterPulledType,
} from "./pulled_type_snapshot.ts";
import type { ExtensionTypeRow } from "../infrastructure/persistence/extension_catalog_store.ts";
import { canonicalizePath } from "../infrastructure/persistence/canonicalize_path.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import "../domain/models/models.ts";
import "../domain/vaults/vault_types.ts";
import "../domain/datastore/datastore_types.ts";
import "../domain/reports/builtin/mod.ts";

const pulledRoot = canonicalizePath(
  join("/repo", ".swamp", "pulled-extensions"),
);

function row(
  sourcePath: string,
  kind: ExtensionTypeRow["kind"],
  type: string,
): ExtensionTypeRow {
  return {
    type_normalized: type,
    kind,
    bundle_path: "",
    source_path: sourcePath,
    version: "",
    description: "",
    extends_type: kind === "extension" ? type : "",
    source_mtime: "",
    source_fingerprint: "",
  };
}

Deno.test("capturePulledTypes: records typed rows and add-on targets per extension", () => {
  const rows = [
    row(join(pulledRoot, "@a/one", "models", "m.ts"), "model", "@a/m"),
    row(join(pulledRoot, "@a/one", "vaults", "v.ts"), "vault", "@a/v"),
    row(join(pulledRoot, "@a/one", "models", "x.ts"), "extension", "@a/m"),
    row(join(pulledRoot, "@a/one", "models", "bad.ts"), "model", ""),
    row(join(pulledRoot, "@a/one", "models", "y.ts"), "extension", ""),
  ];
  const catalog = {
    findBySourcePathPrefix: (prefix: string) =>
      prefix === canonicalizePath(join(pulledRoot, "@a/one") + "/") ? rows : [],
  };

  const snapshot = capturePulledTypes(catalog, pulledRoot, [
    "@a/one",
    "@a/empty",
  ]);

  assertEquals([...snapshot.keys()], ["@a/one"]);
  assertEquals(snapshot.get("@a/one"), [
    { kind: "model", type: "@a/m" },
    { kind: "vault", type: "@a/v" },
    // An add-on records the type it extends (swamp-club#2745).
    { kind: "extension", type: "@a/m" },
  ]);
});

Deno.test("unregisterPulledType: removes the type from the registry of its kind", () => {
  const id = crypto.randomUUID();
  const lazy = (type: string) => ({
    type,
    bundlePath: "",
    sourcePath: "",
    version: "",
  });
  const types = {
    model: `@test/model-${id}`,
    vault: `@test/vault-${id}`,
    datastore: `@test/datastore-${id}`,
    report: `@test/report-${id}`,
    webhook: `@test/webhook-${id}`,
  };
  modelRegistry.registerLazy({
    ...lazy(types.model),
    type: ModelType.create(types.model),
  });
  vaultTypeRegistry.registerLazy(lazy(types.vault));
  datastoreTypeRegistry.registerLazy(lazy(types.datastore));
  reportRegistry.registerLazy(lazy(types.report));
  webhookTypeRegistry.registerLazy(lazy(types.webhook));
  try {
    for (const kind of Object.keys(types) as (keyof typeof types)[]) {
      assertEquals(unregisterPulledType({ kind, type: types[kind] }), true);
    }
    assertEquals(
      [
        modelRegistry.has(types.model),
        vaultTypeRegistry.has(types.vault),
        datastoreTypeRegistry.has(types.datastore),
        reportRegistry.has(types.report),
        webhookTypeRegistry.has(types.webhook),
      ],
      [false, false, false, false, false],
    );
  } finally {
    modelRegistry.invalidateType(types.model);
    vaultTypeRegistry.invalidateType(types.vault);
    datastoreTypeRegistry.invalidateType(types.datastore);
    reportRegistry.invalidateType(types.report);
    webhookTypeRegistry.invalidateType(types.webhook);
  }
});

/**
 * Runs `fn`, then puts back any built-in entry it removed or replaced, so
 * a red run cannot leave the process-global registries without them.
 */
async function preservingBuiltIns(fn: () => void | Promise<void>) {
  const model = modelRegistry.get("command/shell")!;
  const vault = vaultTypeRegistry.get("local_encryption")!;
  const datastore = datastoreTypeRegistry.get("filesystem")!;
  const report = reportRegistry.get("@swamp/method-summary")!;
  try {
    await fn();
  } finally {
    if (modelRegistry.get("command/shell") !== model) {
      modelRegistry.invalidateType("command/shell");
      modelRegistry.register(model);
    }
    if (vaultTypeRegistry.get("local_encryption") !== vault) {
      vaultTypeRegistry.invalidateType("local_encryption");
      vaultTypeRegistry.register(vault);
    }
    if (datastoreTypeRegistry.get("filesystem") !== datastore) {
      datastoreTypeRegistry.invalidateType("filesystem");
      datastoreTypeRegistry.register(datastore);
    }
    if (reportRegistry.get("@swamp/method-summary") !== report) {
      reportRegistry.invalidateType("@swamp/method-summary");
      reportRegistry.register("@swamp/method-summary", report);
    }
  }
}

const BUILT_IN_REFS = [
  { kind: "model", type: "command/shell" },
  { kind: "model", type: "swamp/grant" },
  { kind: "vault", type: "local_encryption" },
  { kind: "datastore", type: "filesystem" },
  { kind: "report", type: "@swamp/method-summary" },
] as const;

Deno.test("isBuiltInType: true for built-in types of every kind, false for extension types (swamp-club#2746)", () => {
  for (const ref of BUILT_IN_REFS) {
    assertEquals(isBuiltInType(ref), true, `${ref.kind} ${ref.type}`);
  }
  const id = crypto.randomUUID();
  for (
    const kind of ["model", "vault", "datastore", "report", "webhook"] as const
  ) {
    assertEquals(isBuiltInType({ kind, type: `@test/${kind}-${id}` }), false);
  }
});

Deno.test("unregisterPulledType: leaves a built-in type registered and returns false (swamp-club#2746)", async () => {
  await preservingBuiltIns(() => {
    const before = BUILT_IN_REFS.map((ref) => getRegistered(ref));
    for (const ref of BUILT_IN_REFS) {
      assertEquals(unregisterPulledType(ref), false, `${ref.kind} ${ref.type}`);
    }
    assertEquals(BUILT_IN_REFS.map((ref) => getRegistered(ref)), before);
  });
});

function getRegistered(
  ref: (typeof BUILT_IN_REFS)[number],
): unknown {
  switch (ref.kind) {
    case "model":
      return modelRegistry.get(ref.type);
    case "vault":
      return vaultTypeRegistry.get(ref.type);
    case "datastore":
      return datastoreTypeRegistry.get(ref.type);
    case "report":
      return reportRegistry.get(ref.type);
  }
}
