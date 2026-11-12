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
import type { VaultConfiguration } from "../domain/vaults/vault_provider.ts";
import type { ExtensionAutoResolver } from "../domain/extensions/extension_auto_resolver.ts";
import { YamlVaultConfigRepository } from "../infrastructure/persistence/yaml_vault_config_repository.ts";
import { withRuntimeBaseDir } from "../domain/vaults/local_encryption_key_source.ts";
import { RENAMED_VAULT_TYPES } from "../domain/vaults/vault_types.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import {
  fixCjsEsmInterop,
  installZodGlobal,
  rewriteZodImports,
} from "../domain/models/bundle.ts";
import { scanExpressions } from "../domain/expressions/expression_scanner.ts";
import { isStagingEntryName } from "../domain/extensions/install_journal.ts";

const logger = getLogger(["swamp", "datastore", "expressions"]);

const ENV_PATTERN = /^env\.([a-zA-Z_][a-zA-Z0-9_]*)$/;

const VAULT_GET_PATTERN =
  /^vault\.get\(\s*(?:(['"`])(.+?)\1|([^\s,)]+))\s*,\s*(?:(['"`])(.+?)\4|([^\s,)]+))\s*\)$/;

export interface DatastoreExpressionContext {
  repoDir: string;
  managedConfig?: boolean;
  vaultServiceFactory?: (repoDir: string) => Promise<VaultService>;
  /** absent or null: only vault types already installed in the checkout are used */
  autoResolver?: Pick<ExtensionAutoResolver, "resolve"> | null;
}

interface SkippedVault {
  configuration: VaultConfiguration;
  error: unknown;
}

interface EarlyVaults {
  service: VaultService;
  skipped: Map<string, SkippedVault>;
}

async function loadCachedVaultBundles(repoDir: string): Promise<void> {
  // rewriteZodImports makes each bundle read zod from this global
  installZodGlobal();
  const bundlesDir = join(repoDir, ".swamp", "vault-bundles");
  try {
    for await (const fpDir of Deno.readDir(bundlesDir)) {
      if (!fpDir.isDirectory) continue;
      // an in-flight or interrupted install's staging: half-written bundles
      // that are not installed
      if (isStagingEntryName(fpDir.name)) continue;
      for await (const file of Deno.readDir(join(bundlesDir, fpDir.name))) {
        if (!file.name.endsWith(".js")) continue;
        try {
          const bundlePath = join(bundlesDir, fpDir.name, file.name);
          let js = await Deno.readTextFile(bundlePath);
          const fixed = fixCjsEsmInterop(rewriteZodImports(js, bundlePath));
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

async function createEarlyVaults(repoDir: string): Promise<EarlyVaults> {
  await loadCachedVaultBundles(repoDir);

  const vaultsDir = join(repoDir, "vaults");
  const vaultService = new VaultService();
  const skipped = new Map<string, SkippedVault>();
  const vaultRepo = new YamlVaultConfigRepository(
    repoDir,
    undefined,
    vaultsDir,
  );

  let vaultConfigs;
  try {
    vaultConfigs = await vaultRepo.findAll();
  } catch {
    return { service: vaultService, skipped };
  }

  for (const vaultConfig of vaultConfigs) {
    let vaultType = vaultConfig.type;
    const renamedTo = RENAMED_VAULT_TYPES[vaultType.toLowerCase()];
    if (renamedTo) vaultType = renamedTo;
    const configuration: VaultConfiguration = {
      name: vaultConfig.name,
      type: vaultType,
      config: withRuntimeBaseDir(vaultType, vaultConfig.config, repoDir),
      auditReads: vaultConfig.auditReads,
    };
    try {
      vaultService.registerVault(configuration);
    } catch (error) {
      // a vault.get naming it reports this cause in its own error
      logger
        .debug`Vault ${vaultConfig.name} not available for datastore config expressions: ${error}`;
      skipped.set(vaultConfig.name, { configuration, error });
    }
  }

  return { service: vaultService, skipped };
}

function skippedVaultMessage(vault: SkippedVault): string {
  const { name, type } = vault.configuration;
  if (type.startsWith("@") && !vaultTypeRegistry.has(type)) {
    return `Vault '${name}' is defined in vaults/, but its vault type ` +
      `'${type}' is not installed in this checkout. ` +
      `Install it with: swamp extension pull ${type}`;
  }
  const reason = vault.error instanceof Error
    ? vault.error.message
    : String(vault.error);
  return `Vault '${name}' is defined in vaults/ but could not be loaded: ${reason}`;
}

export async function resolveDatastoreExpressions(
  config: Record<string, unknown>,
  context: DatastoreExpressionContext,
): Promise<Record<string, unknown>> {
  let earlyVaults: EarlyVaults | null = null;
  const typeResolutions = new Map<string, Promise<boolean>>();

  async function getEarlyVaults(): Promise<EarlyVaults> {
    if (earlyVaults) return earlyVaults;
    if (context.managedConfig) {
      throw new UserError(
        "Vault expressions in datastore config are not supported when " +
          "managedConfig is enabled. Managed config stores vault " +
          "configurations in the datastore tier, which is not available " +
          "during datastore initialization. Use environment variable " +
          "expressions instead.",
      );
    }
    logger
      .debug`Creating vault service for datastore config expression resolution`;
    earlyVaults = context.vaultServiceFactory
      ? {
        service: await context.vaultServiceFactory(context.repoDir),
        skipped: new Map(),
      }
      : await createEarlyVaults(context.repoDir);
    logger.debug`Vault service created successfully`;
    return earlyVaults;
  }

  // never touches vaultTypeRegistry.ensureLoaded: the vault loader awaits the
  // datastore resolution this call is part of, so loading through it deadlocks
  async function recoverSkippedVault(
    vaults: EarlyVaults,
    vault: SkippedVault,
  ): Promise<void> {
    const { name, type } = vault.configuration;
    if (
      context.autoResolver && type.startsWith("@") &&
      !vaultTypeRegistry.has(type)
    ) {
      let resolution = typeResolutions.get(type);
      if (!resolution) {
        resolution = context.autoResolver.resolve(type).catch((error) => {
          logger.debug`Auto-resolving vault type ${type} failed: ${error}`;
          return false;
        });
        typeResolutions.set(type, resolution);
      }
      await resolution;
    }
    // a concurrent vault.get on the same vault may have registered it already
    if (!vaults.skipped.has(name)) return;
    if (vaultTypeRegistry.has(type)) {
      try {
        vaults.service.registerVault(vault.configuration);
        vaults.skipped.delete(name);
        return;
      } catch (error) {
        vault.error = error;
      }
    }
    throw new UserError(
      `Failed to resolve vault expression in datastore config: ${
        skippedVaultMessage(vault)
      }`,
    );
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
      const vaults = await getEarlyVaults();
      const skipped = vaults.skipped.get(vaultName);
      if (skipped) await recoverSkippedVault(vaults, skipped);
      try {
        return await vaults.service.get(
          vaultName,
          secretKey,
          "datastore-config",
        );
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
    const spans = scanExpressions(str);
    if (spans.length === 0) return str;

    if (
      spans.length === 1 &&
      spans[0].start === 0 &&
      spans[0].end === str.trimEnd().length
    ) {
      return await resolveExpression(spans[0].inner);
    }

    let result = "";
    let last = 0;
    for (const span of spans) {
      const resolved = await resolveExpression(span.inner);
      result += str.slice(last, span.start) + String(resolved);
      last = span.end;
    }
    return result + str.slice(last);
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
