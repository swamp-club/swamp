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

import { getLogger } from "@logtape/logtape";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  type Grant,
  GRANT_MODEL_TYPE,
  grantModel,
} from "../models/access/grant_model.ts";
import { parseSubject, subjectToString } from "./subject.ts";
import { parseResourceSelector } from "./resource_selector.ts";
import type { AuthMode } from "./serve_auth_config.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { Definition } from "../definitions/definition.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { readStoredGrants } from "./stored_grant_reader.ts";
import { createResourceWriter } from "../models/data_writer.ts";

const logger = getLogger(["swamp", "admin-materializer"]);

const GRANT_DATA_NAME = "grant-main";

export interface MaterializeResult {
  created: number;
  updated: number;
  revoked: number;
  reactivated: number;
  unchanged: number;
}

export interface StoredConfigGrant {
  grant: Grant;
  modelId: string;
}

export interface AdminGrantStore {
  /**
   * an instance name can hold several stored copies: serve instances sharing a
   * datastore each create their own
   */
  queryConfigGrants(): Promise<Map<string, StoredConfigGrant[]>>;
  findDefinitionId(instanceName: string): Promise<string | undefined>;
  ensureDefinition(instanceName: string): Promise<string>;
  writeGrant(
    modelId: string,
    instanceName: string,
    grant: Grant,
  ): Promise<void>;
}

export async function hashPrincipal(principalId: string): Promise<string> {
  const data = new TextEncoder().encode(principalId);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function instanceNameForAdmin(hash: string): string {
  return `grant-config-${hash}`;
}

function buildAdminGrant(adminPrincipal: string): Grant {
  const subject = parseSubject(adminPrincipal);
  const resource = parseResourceSelector("access:*");
  return {
    id: crypto.randomUUID(),
    subject,
    effect: "allow",
    actions: ["admin"],
    resource,
    state: "active",
    source: "config",
    createdBy: { kind: "user", id: "system" },
    createdAt: new Date().toISOString(),
  };
}

/**
 * called with the path of each grant definition this store creates, right after
 * it is written, so a caller can re-mark it dirty before pushing
 */
export function createAdminGrantStore(
  readRepo: DefinitionRepository,
  writeRepo: DefinitionRepository,
  dataRepo: UnifiedDataRepository,
  onDefinitionSaved?: (path: string) => void,
): AdminGrantStore {
  return {
    async queryConfigGrants() {
      const configGrants = new Map<string, StoredConfigGrant[]>();
      for (const { grant, data, modelId } of await readStoredGrants(dataRepo)) {
        if (grant.source !== "config") continue;
        const modelName = data.tags["modelName"] ?? "";
        const copy = { grant, modelId };
        const copies = configGrants.get(modelName);
        if (copies) {
          copies.push(copy);
        } else {
          configGrants.set(modelName, [copy]);
        }
      }
      return configGrants;
    },

    async findDefinitionId(instanceName: string) {
      const def = await readRepo.findByName(GRANT_MODEL_TYPE, instanceName);
      return def?.id;
    },

    async ensureDefinition(instanceName: string) {
      let def = await readRepo.findByName(
        GRANT_MODEL_TYPE,
        instanceName,
      );
      if (!def) {
        def = Definition.create({
          type: GRANT_MODEL_TYPE.normalized,
          name: instanceName,
          typeVersion: grantModel.version,
        });
        await writeRepo.save(GRANT_MODEL_TYPE, def);
        onDefinitionSaved?.(writeRepo.getPath(GRANT_MODEL_TYPE, def.id));
      }
      return def.id;
    },

    async writeGrant(modelId: string, instanceName: string, grant: Grant) {
      const { writeResource } = createResourceWriter(
        dataRepo,
        GRANT_MODEL_TYPE,
        modelId,
        grantModel.resources!,
        undefined,
        undefined,
        undefined,
        undefined,
        instanceName,
      );
      await writeResource(
        "grant",
        GRANT_DATA_NAME,
        grant as unknown as Record<string, unknown>,
      );
    },
  };
}

export async function materializeAdmins(
  mode: AuthMode,
  admins: string[],
  store: AdminGrantStore,
): Promise<MaterializeResult> {
  if (mode === "none") {
    return { created: 0, updated: 0, revoked: 0, reactivated: 0, unchanged: 0 };
  }

  const result: MaterializeResult = {
    created: 0,
    updated: 0,
    revoked: 0,
    reactivated: 0,
    unchanged: 0,
  };

  const configGrants = await store.queryConfigGrants();
  const desiredInstanceNames = new Set<string>();
  const uniqueAdmins = [...new Set(admins)];

  for (const admin of uniqueAdmins) {
    const hash = await hashPrincipal(admin);
    const instanceName = instanceNameForAdmin(hash);
    desiredInstanceNames.add(instanceName);

    // leave every copy of a wanted admin grant alone: revoking extras needs
    // peers to agree on a survivor, and one could revoke the copy another kept,
    // leaving no active grant
    const copies = configGrants.get(instanceName) ?? [];
    if (copies.some((c) => c.grant.state === "active")) {
      result.unchanged++;
      continue;
    }

    if (copies.length > 0) {
      const existing = selectCopyToReactivate(
        copies,
        await store.findDefinitionId(instanceName),
      );
      const reactivated: Grant = { ...existing.grant, state: "active" };
      await store.writeGrant(existing.modelId, instanceName, reactivated);
      result.reactivated++;
      logger.info`Re-activated admin grant for ${admin}`;
      continue;
    }

    const modelId = await store.ensureDefinition(instanceName);
    const grant = buildAdminGrant(admin);
    await store.writeGrant(modelId, instanceName, grant);
    result.created++;
    logger.info`Created admin grant for ${admin}`;
  }

  for (const [instanceName, copies] of configGrants) {
    if (desiredInstanceNames.has(instanceName)) continue;
    for (const { grant, modelId } of copies) {
      if (grant.state === "revoked") {
        result.unchanged++;
        continue;
      }

      const revoked: Grant = { ...grant, state: "revoked" };
      await store.writeGrant(modelId, instanceName, revoked);
      const revokedSubject = subjectToString(grant.subject);
      result.revoked++;
      logger.info`Revoked admin grant for ${revokedSubject}`;
    }
  }

  return result;
}

/**
 * reactivate the copy whose model id matches the stored definition, so it is
 * not orphaned data, then the lowest model id
 */
function selectCopyToReactivate(
  copies: readonly StoredConfigGrant[],
  definitionId: string | undefined,
): StoredConfigGrant {
  const byModelId = [...copies].sort((a, b) =>
    a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0
  );
  return byModelId.find((c) => c.modelId === definitionId) ??
    byModelId[0];
}

export interface MigrateGrantDefinitionsResult {
  moved: number;
  skipped: number;
  movedPaths: string[];
}

export async function migrateGrantDefinitions(
  sourceDir: string,
  destDir: string,
): Promise<MigrateGrantDefinitionsResult> {
  const result: MigrateGrantDefinitionsResult = {
    moved: 0,
    skipped: 0,
    movedPaths: [],
  };

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(sourceDir)) {
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return result;
    }
    throw error;
  }

  await ensureDir(destDir);

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;

    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(destDir, entry.name);

    try {
      await Deno.stat(dstPath);
      result.skipped++;
      logger
        .debug`Skipping grant definition migration for ${entry.name}: already exists at destination`;
    } catch (statError) {
      if (!(statError instanceof Deno.errors.NotFound)) throw statError;

      try {
        await Deno.rename(srcPath, dstPath);
      } catch {
        // cross-filesystem move: rename throws EXDEV, so copy then remove;
        // NotFound means a concurrent run already migrated the file, skip it
        try {
          await Deno.copyFile(srcPath, dstPath);
        } catch (copyError) {
          if (copyError instanceof Deno.errors.NotFound) continue;
          throw copyError;
        }
        try {
          await Deno.remove(srcPath);
        } catch (removeError) {
          if (!(removeError instanceof Deno.errors.NotFound)) throw removeError;
        }
      }
      result.moved++;
      result.movedPaths.push(dstPath);
      logger.info`Migrated grant definition ${entry.name} to auto-definitions`;
    }
  }

  return result;
}
