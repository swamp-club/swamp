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
 * Where vault create and vault migrate learn a target type's config
 * fields before its extension is installed, so the CLI can ask for the
 * missing ones (swamp-club#3003).
 *
 * The registry's field list is extracted from the extension's source at
 * push time by a text scan, so it is a guide, not a gate: the installed
 * schema has the final say on whether a config is valid.
 */

import type { ExtensionAutoResolver } from "../../domain/extensions/extension_auto_resolver.ts";
import type { VaultTypeInfo } from "../../domain/vaults/vault_type_registry.ts";
import {
  describeVaultConfigFields,
  type VaultConfigField,
  vaultConfigField,
} from "../../domain/vaults/vault_config_fields.ts";

/**
 * The config fields the registry publishes for an extension vault type,
 * or null when they are unknown: the type is not in the registry, the
 * metadata carries no fields, or there is no resolver to ask.
 */
export type RegistryConfigFieldsLookup = (
  type: string,
) => Promise<VaultConfigField[] | null>;

/**
 * Asks the auto resolver for a type's published config fields, once per
 * type: the CLI prompt and the generator's pre-install check share one
 * registry request. The memo lives on the deps instance of a single
 * command invocation (or serve request), so it never outlives an install.
 */
export function createRegistryConfigFieldsLookup(
  resolver: ExtensionAutoResolver | null,
): RegistryConfigFieldsLookup {
  const memo = new Map<string, Promise<VaultConfigField[] | null>>();
  return (type) => {
    const cached = memo.get(type);
    if (cached) return cached;
    const pending = lookupRegistryConfigFields(resolver, type);
    memo.set(type, pending);
    return pending;
  };
}

/**
 * Reads the registry's answer defensively: the metadata is whatever the
 * publisher's client sent, so an entry of the wrong shape means "unknown",
 * never a crash before the install.
 */
async function lookupRegistryConfigFields(
  resolver: ExtensionAutoResolver | null,
  type: string,
): Promise<VaultConfigField[] | null> {
  if (!resolver) return null;
  try {
    const metadata = await resolver.describeTypeInRegistry(type);
    const vaults: unknown = metadata?.vaults;
    if (!Array.isArray(vaults)) return null;
    const entry = vaults.find((v: unknown) =>
      isRecord(v) && typeof v.type === "string" &&
      v.type.toLowerCase() === type.toLowerCase()
    );
    if (!isRecord(entry) || !Array.isArray(entry.configFields)) return null;
    const fields = entry.configFields.flatMap((f: unknown) =>
      isRecord(f) && typeof f.name === "string"
        ? [vaultConfigField({
          name: f.name,
          type: typeof f.type === "string" ? f.type : "unknown",
          description: typeof f.description === "string"
            ? f.description
            : undefined,
          required: f.required === true,
        })]
        : []
    );
    return fields.length > 0 ? fields : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** What a generator needs to describe a target type's config. */
export interface VaultTypeConfigDeps {
  /** Loads a lazily-indexed type if needed and says whether it is known. */
  isVaultTypeLoaded: (type: string) => Promise<boolean>;
  getVaultTypeInfo: (type: string) => VaultTypeInfo | undefined;
  findRegistryConfigFields: RegistryConfigFieldsLookup;
}

/**
 * The config fields of a target vault type: from its schema when the type
 * is installed (an empty list for a built-in or schema-less type), from
 * the registry when it is an extension type still to be installed, and
 * null when nothing can say.
 */
export async function describeVaultTargetConfig(
  deps: VaultTypeConfigDeps,
  type: string,
): Promise<VaultConfigField[] | null> {
  if (await deps.isVaultTypeLoaded(type)) {
    const info = deps.getVaultTypeInfo(type);
    if (!info) return null;
    if (info.isBuiltIn || !info.createProvider || !info.configSchema) {
      return [];
    }
    return describeVaultConfigFields(info.configSchema);
  }
  if (!type.startsWith("@")) return null;
  return await deps.findRegistryConfigFields(type);
}
