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

import { join } from "@std/path";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import { removeAttachedExtensionsForType } from "../domain/extensions/model_kind_adapter.ts";
import type { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { canonicalizePath } from "../infrastructure/persistence/canonicalize_path.ts";

/** The catalog kinds that register a type of their own in a registry. */
export type PulledTypeKind =
  | "model"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

/**
 * One type a pulled extension registered in this process, or, with kind
 * `extension`, a model type its add-on attached members to
 * (swamp-club#2745).
 */
export interface PulledTypeRef {
  readonly kind: PulledTypeKind | "extension";
  readonly type: string;
}

/**
 * The types each pulled extension registered, by extension name. Serve
 * keeps one so a reload can unregister an extension's types after its
 * catalog rows and files are gone (swamp-club#2742): a loaded registry
 * entry does not record which source it came from.
 */
export type PulledTypeSnapshot = ReadonlyMap<string, readonly PulledTypeRef[]>;

const PULLED_TYPE_KINDS: ReadonlySet<string> = new Set<PulledTypeKind>([
  "model",
  "vault",
  "datastore",
  "report",
  "webhook",
]);

export function isPulledTypeKind(kind: string): kind is PulledTypeKind {
  return PULLED_TYPE_KINDS.has(kind);
}

/**
 * Reads, for each named extension, the types its catalog rows under the
 * pulled root register, and the model types its add-on rows extend. Rows
 * without a type (failed or conflict-settled) are left out.
 */
export function capturePulledTypes(
  catalog: Pick<ExtensionCatalogStore, "findBySourcePathPrefix">,
  pulledRoot: string,
  names: readonly string[],
): Map<string, PulledTypeRef[]> {
  const snapshot = new Map<string, PulledTypeRef[]>();
  for (const name of names) {
    const prefix = canonicalizePath(join(pulledRoot, name) + "/");
    const refs: PulledTypeRef[] = [];
    for (const row of catalog.findBySourcePathPrefix(prefix)) {
      if (row.kind === "extension") {
        if (row.extends_type) {
          refs.push({ kind: "extension", type: row.extends_type });
        }
        continue;
      }
      if (!row.type_normalized || !isPulledTypeKind(row.kind)) continue;
      refs.push({ kind: row.kind, type: row.type_normalized });
    }
    if (refs.length > 0) snapshot.set(name, refs);
  }
  return snapshot;
}

/**
 * True when `ref` names a type that ships with swamp. A pulled extension
 * that declares such a type never replaces it, and removing the extension
 * never unregisters it (swamp-club#2746). Built-in webhook schemes are not
 * in the webhook registry, so no webhook type is built in.
 */
export function isBuiltInType(
  ref: PulledTypeRef & { readonly kind: PulledTypeKind },
): boolean {
  switch (ref.kind) {
    case "model":
      return modelRegistry.isBuiltIn(ref.type);
    case "vault":
      return vaultTypeRegistry.get(ref.type)?.isBuiltIn === true;
    case "datastore":
      return datastoreTypeRegistry.get(ref.type)?.isBuiltIn === true;
    case "report":
      return reportRegistry.isBuiltIn(ref.type);
    case "webhook":
      return false;
  }
}

/**
 * Removes one pulled type from the registry of its kind. Returns false,
 * leaving the registry as it is, for a built-in type.
 */
export function unregisterPulledType(
  ref: PulledTypeRef & { readonly kind: PulledTypeKind },
): boolean {
  if (isBuiltInType(ref)) return false;
  switch (ref.kind) {
    case "model":
      modelRegistry.invalidateType(ref.type);
      removeAttachedExtensionsForType(ref.type);
      return true;
    case "vault":
      vaultTypeRegistry.invalidateType(ref.type);
      return true;
    case "datastore":
      datastoreTypeRegistry.invalidateType(ref.type);
      return true;
    case "report":
      reportRegistry.invalidateType(ref.type);
      return true;
    case "webhook":
      webhookTypeRegistry.invalidateType(ref.type);
      return true;
  }
}
