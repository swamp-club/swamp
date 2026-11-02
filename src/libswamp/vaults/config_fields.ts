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
 * the registry's field list comes from a text scan of the extension source at
 * push time: a guide, not a gate; the installed schema decides validity
 */

import type { ExtensionAutoResolver } from "../../domain/extensions/extension_auto_resolver.ts";
import type { VaultTypeInfo } from "../../domain/vaults/vault_type_registry.ts";
import {
  describeVaultConfigFields,
  type VaultConfigField,
  vaultConfigField,
} from "../../domain/vaults/vault_config_fields.ts";

export type RegistryConfigFieldsLookup = (
  type: string,
) => Promise<VaultConfigField[] | null>;

/**
 * memoized per type so the CLI prompt and the generator's pre-install check
 * share one registry request; the memo lives on one command invocation or serve
 * request, so it never outlives an install
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
 * the metadata is whatever the publisher's client sent, so an entry of the
 * wrong shape means unknown, never a crash before the install
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

export interface VaultTypeConfigDeps {
  isVaultTypeLoaded: (type: string) => Promise<boolean>;
  getVaultTypeInfo: (type: string) => VaultTypeInfo | undefined;
  findRegistryConfigFields: RegistryConfigFieldsLookup;
}

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
