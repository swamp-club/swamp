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

import { join, toFileUrl } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { UserError } from "../domain/errors.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LocalEncryptionConfig } from "../domain/vaults/local_encryption_vault_provider.ts";
import { RENAMED_VAULT_TYPES } from "../domain/vaults/vault_types.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import {
  fixCjsEsmInterop,
  rewriteZodImports,
} from "../domain/models/bundle.ts";

const logger = getLogger(["swamp", "datastore", "expressions"]);

const EXPRESSION_PATTERN = /\$\{\{\s*(.+?)\s*\}\}/gs;

const ENV_PATTERN = /^env\.([a-zA-Z_][a-zA-Z0-9_]*)$/;

const VAULT_GET_PATTERN =
  /^vault\.get\(\s*(?:(['"`])(.+?)\1|([^\s,)]+))\s*,\s*(?:(['"`])(.+?)\4|([^\s,)]+))\s*\)$/;

export interface DatastoreExpressionContext {
  repoDir: string;
  managedConfig?: boolean;
  vaultServiceFactory?: (repoDir: string) => Promise<VaultService>;
}

async function loadCachedVaultBundles(repoDir: string): Promise<void> {
  const bundlesDir = join(repoDir, ".swamp", "vault-bundles");
  try {
    for await (const fpDir of Deno.readDir(bundlesDir)) {
      if (!fpDir.isDirectory) continue;
      for await (const file of Deno.readDir(join(bundlesDir, fpDir.name))) {
        if (!file.name.endsWith(".js")) continue;
        try {
          const bundlePath = join(bundlesDir, fpDir.name, file.name);
          let js = await Deno.readTextFile(bundlePath);
          const fixed = fixCjsEsmInterop(rewriteZodImports(js));
          if (fixed !== js) {
            js = fixed;
            await Deno.writeTextFile(bundlePath, js);
          }
          const importUrl = toFileUrl(bundlePath).href;
          const mod = await import(importUrl);
          if (
            mod.vault && typeof mod.vault.type === "string" &&
            typeof mod.vault.createProvider === "function"
          ) {
            if (!vaultTypeRegistry.has(mod.vault.type)) {
              vaultTypeRegistry.register({
                type: mod.vault.type,
                name: mod.vault.name ?? mod.vault.type,
                description: mod.vault.description ?? "",
                configSchema: mod.vault.configSchema,
                createProvider: mod.vault.createProvider,
                isBuiltIn: false,
              });
              logger
                .debug`Loaded vault extension ${mod.vault.type} from cached bundle for datastore config resolution`;
            }
          }
        } catch (err) {
          logger
            .debug`Failed to load vault bundle ${file.name}: ${err}`;
        }
      }
    }
  } catch {
    // vault-bundles directory doesn't exist — no extension vaults installed
  }
}

async function createEarlyVaultService(
  repoDir: string,
): Promise<VaultService> {
  await loadCachedVaultBundles(repoDir);

  const vaultsDir = join(repoDir, "vaults");
  const vaultService = new VaultService();
  const vaultRepo = new YamlVaultConfigRepository(
    repoDir,
    undefined,
    vaultsDir,
  );

  let vaultConfigs;
  try {
    vaultConfigs = await vaultRepo.findAll();
  } catch {
    return vaultService;
  }

  for (const vaultConfig of vaultConfigs) {
    try {
      let vaultType = vaultConfig.type;
      const renamedTo = RENAMED_VAULT_TYPES[vaultType.toLowerCase()];
      if (renamedTo) vaultType = renamedTo;

      let config = vaultConfig.config;
      if (vaultType === "local_encryption") {
        const localConfig = config as LocalEncryptionConfig | undefined;
        if (!localConfig?.base_dir) {
          config = { ...localConfig, base_dir: repoDir };
        }
      }

      vaultService.registerVault({
        name: vaultConfig.name,
        type: vaultType,
        config,
        auditReads: vaultConfig.auditReads,
      });
    } catch (error) {
      logger
        .warn`Vault ${vaultConfig.name} not available for datastore config expressions: ${error}`;
    }
  }

  return vaultService;
}

export async function resolveDatastoreExpressions(
  config: Record<string, unknown>,
  context: DatastoreExpressionContext,
): Promise<Record<string, unknown>> {
  let vaultService: VaultService | null = null;

  async function getVaultService(): Promise<VaultService> {
    if (vaultService) return vaultService;
    if (context.managedConfig) {
      throw new UserError(
        "Vault expressions in datastore config are not supported when " +
          "managedConfig is enabled. Managed config stores vault " +
          "configurations in the datastore tier, which is not available " +
          "during datastore initialization. Use environment variable " +
          "expressions instead.",
      );
    }
    const factory = context.vaultServiceFactory ?? createEarlyVaultService;
    logger
      .debug`Creating vault service for datastore config expression resolution`;
    vaultService = await factory(context.repoDir);
    logger.debug`Vault service created successfully`;
    return vaultService;
  }

  async function resolveExpression(expr: string): Promise<string> {
    const envMatch = expr.match(ENV_PATTERN);
    if (envMatch) {
      const varName = envMatch[1];
      const value = Deno.env.get(varName);
      if (value === undefined || value === "") {
        throw new UserError(
          `Environment variable "${varName}" is not set or empty ` +
            `(referenced in datastore config expression)`,
        );
      }
      return value;
    }

    const vaultMatch = expr.match(VAULT_GET_PATTERN);
    if (vaultMatch) {
      const vaultName = vaultMatch[2] ?? vaultMatch[3];
      const secretKey = vaultMatch[5] ?? vaultMatch[6];
      const service = await getVaultService();
      try {
        return await service.get(vaultName, secretKey, "datastore-config");
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new UserError(
          `Failed to resolve vault expression in datastore config: ${msg}`,
        );
      }
    }

    throw new UserError(
      `Unsupported expression in datastore config: "${expr}". ` +
        `Only env.VAR_NAME and vault.get(vaultName, secretKey) are supported.`,
    );
  }

  async function resolveString(str: string): Promise<unknown> {
    const matches = [...str.matchAll(EXPRESSION_PATTERN)];
    if (matches.length === 0) return str;

    if (
      matches.length === 1 &&
      matches[0].index === 0 &&
      matches[0][0].length === str.trimEnd().length
    ) {
      return await resolveExpression(matches[0][1].trim());
    }

    let result = str;
    for (const match of matches) {
      const rawExpr = match[0];
      const inner = match[1].trim();
      const resolved = await resolveExpression(inner);
      result = result.split(rawExpr).join(String(resolved));
    }
    return result;
  }

  async function resolveValue(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      return await resolveString(value);
    }
    if (Array.isArray(value)) {
      return await Promise.all(value.map(resolveValue));
    }
    if (value !== null && typeof value === "object") {
      return await resolveRecord(value as Record<string, unknown>);
    }
    return value;
  }

  async function resolveRecord(
    obj: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = await resolveValue(val);
    }
    return result;
  }

  return await resolveRecord(config);
}
