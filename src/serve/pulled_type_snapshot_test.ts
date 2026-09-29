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

Deno.test("capturePulledTypes: records typed rows of registering kinds per extension", () => {
  const rows = [
    row(join(pulledRoot, "@a/one", "models", "m.ts"), "model", "@a/m"),
    row(join(pulledRoot, "@a/one", "vaults", "v.ts"), "vault", "@a/v"),
    row(join(pulledRoot, "@a/one", "models", "x.ts"), "extension", "@a/m"),
    row(join(pulledRoot, "@a/one", "models", "bad.ts"), "model", ""),
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
      unregisterPulledType({ kind, type: types[kind] });
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
