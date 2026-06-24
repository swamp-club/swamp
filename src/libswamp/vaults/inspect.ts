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

import type { VaultAnnotationData } from "../../domain/vaults/vault_annotation.ts";
import type { RefreshHookData } from "../../domain/vaults/refresh_hook.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultInspectConfigInfo {
  id: string;
  name: string;
  type: string;
}

export interface VaultInspectData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  sizeBytes: number;
  sizeChars: number;
  valueType: string;
  supportsAnnotations: boolean;
  hasAnnotation: boolean;
  annotation: VaultAnnotationData | null;
  supportsRefreshHooks: boolean;
  hasRefreshHook: boolean;
  refreshHook: RefreshHookData | null;
}

export type VaultInspectEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultInspectData }
  | { kind: "error"; error: SwampError };

export interface VaultInspectDeps {
  findVault: (name: string) => Promise<VaultInspectConfigInfo | null>;
  listVaultNames: () => Promise<string[]>;
  secretExists: (vaultName: string, key: string) => Promise<boolean>;
  measureSecretSize: (
    vaultName: string,
    key: string,
  ) => Promise<{ bytes: number; chars: number }>;
  supportsAnnotations: (vaultName: string) => Promise<boolean>;
  getAnnotation: (
    vaultName: string,
    key: string,
  ) => Promise<VaultAnnotationData | null>;
  supportsRefreshHooks: (vaultName: string) => Promise<boolean>;
  getRefreshHook: (
    vaultName: string,
    key: string,
  ) => Promise<RefreshHookData | null>;
}

export function createVaultInspectDeps(repoDir: string): VaultInspectDeps {
  const vaultConfigRepo = new YamlVaultConfigRepository(repoDir);
  let vaultServicePromise: Promise<VaultService> | null = null;

  const getVaultService = () => {
    if (!vaultServicePromise) {
      vaultServicePromise = VaultService.fromRepository(repoDir);
    }
    return vaultServicePromise;
  };

  return {
    findVault: (name) => vaultConfigRepo.findByName(name),
    listVaultNames: async () => {
      const all = await vaultConfigRepo.findAll();
      return all.map((v) => v.name);
    },
    secretExists: async (vaultName, key) => {
      const svc = await getVaultService();
      const keys = await svc.list(vaultName);
      return keys.includes(key);
    },
    measureSecretSize: async (vaultName, key) => {
      const svc = await getVaultService();
      const value = await svc.get(vaultName, key);
      return {
        bytes: new TextEncoder().encode(value).byteLength,
        chars: value.length,
      };
    },
    supportsAnnotations: async (vaultName) => {
      const svc = await getVaultService();
      return svc.supportsAnnotations(vaultName);
    },
    getAnnotation: async (vaultName, key) => {
      const svc = await getVaultService();
      const annotation = await svc.getAnnotation(vaultName, key);
      return annotation?.toData() ?? null;
    },
    supportsRefreshHooks: async (vaultName) => {
      const svc = await getVaultService();
      return svc.supportsRefreshHooks(vaultName);
    },
    getRefreshHook: async (vaultName, key) => {
      const svc = await getVaultService();
      if (!svc.supportsRefreshHooks(vaultName)) return null;
      const hook = await svc.getRefreshHook(vaultName, key);
      return hook?.toData() ?? null;
    },
  };
}

export async function* vaultInspect(
  ctx: LibSwampContext,
  deps: VaultInspectDeps,
  vaultName: string,
  secretKey: string,
): AsyncIterable<VaultInspectEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.inspect",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const config = await deps.findVault(vaultName);
      if (!config) {
        const names = await deps.listVaultNames();
        if (names.length === 0) {
          yield {
            kind: "error",
            error: notFound(
              "Vault",
              `${vaultName}. No vaults are configured.`,
            ),
          };
        } else {
          yield {
            kind: "error",
            error: notFound(
              "Vault",
              `${vaultName}. Available vaults: ${names.join(", ")}`,
            ),
          };
        }
        return;
      }

      const exists = await deps.secretExists(vaultName, secretKey);
      if (!exists) {
        yield {
          kind: "error",
          error: validationFailed(
            `Secret '${secretKey}' does not exist in vault '${vaultName}'. Store a secret first with: swamp vault put ${vaultName} ${secretKey}`,
          ),
        };
        return;
      }

      const { bytes: sizeBytes, chars: sizeChars } = await deps
        .measureSecretSize(vaultName, secretKey);

      const hasAnnotationSupport = await deps.supportsAnnotations(vaultName);
      let annotation: VaultAnnotationData | null = null;
      if (hasAnnotationSupport) {
        annotation = await deps.getAnnotation(vaultName, secretKey);
        ctx.logger.debug`Retrieved annotation for ${secretKey}`;
      }

      const hasRefreshHookSupport = await deps.supportsRefreshHooks(vaultName);
      let refreshHook: RefreshHookData | null = null;
      if (hasRefreshHookSupport) {
        refreshHook = await deps.getRefreshHook(vaultName, secretKey);
      }

      yield {
        kind: "completed",
        data: {
          vaultName,
          secretKey,
          vaultType: config.type,
          sizeBytes,
          sizeChars,
          valueType: "string",
          supportsAnnotations: hasAnnotationSupport,
          hasAnnotation: annotation !== null,
          annotation,
          supportsRefreshHooks: hasRefreshHookSupport,
          hasRefreshHook: refreshHook !== null,
          refreshHook,
        },
      };
    })(),
  );
}
