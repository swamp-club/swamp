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
import {
  type Grant,
  GRANT_MODEL_TYPE,
  grantModel,
  GrantSchema,
} from "../models/access/grant_model.ts";
import { parseSubject, subjectToString } from "./subject.ts";
import { parseResourceSelector } from "./resource_selector.ts";
import type { AuthMode } from "./serve_auth_config.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { Definition } from "../definitions/definition.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { ModelType } from "../models/model_type.ts";
import { createResourceWriter } from "../models/data_writer.ts";

const logger = getLogger(["swamp", "admin-materializer"]);

const GRANT_DATA_NAME = "grant-main";

export interface MaterializeResult {
  created: number;
  revoked: number;
  reactivated: number;
  unchanged: number;
}

export interface AdminGrantStore {
  queryConfigGrants(): Promise<
    Map<string, { grant: Grant; modelId: string }>
  >;
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

export function createAdminGrantStore(
  definitionRepo: DefinitionRepository,
  dataRepo: UnifiedDataRepository,
): AdminGrantStore {
  return {
    async queryConfigGrants() {
      const grantDataItems = await dataRepo.findAllForType(GRANT_MODEL_TYPE);

      const configGrants = new Map<
        string,
        { grant: Grant; modelId: string }
      >();
      for (const { data, modelType, modelId } of grantDataItems) {
        const attrs = await readAttributes(
          dataRepo,
          modelType,
          modelId,
          data.name,
        );
        if (!attrs) continue;
        const parsed = GrantSchema.safeParse(attrs);
        if (parsed.success && parsed.data.source === "config") {
          const modelName = data.tags["modelName"] ?? "";
          configGrants.set(modelName, {
            grant: parsed.data,
            modelId,
          });
        }
      }
      return configGrants;
    },

    async ensureDefinition(instanceName: string) {
      let def = await definitionRepo.findByName(
        GRANT_MODEL_TYPE,
        instanceName,
      );
      if (!def) {
        def = Definition.create({
          type: GRANT_MODEL_TYPE.normalized,
          name: instanceName,
        });
        await definitionRepo.save(GRANT_MODEL_TYPE, def);
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

async function readAttributes(
  dataRepo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  const content = await dataRepo.getContent(modelType, modelId, dataName);
  if (!content) return null;
  try {
    const text = new TextDecoder().decode(content);
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    logger
      .warn`Skipping ${modelType.normalized}/${modelId}/${dataName}: failed to parse JSON content: ${error}`;
    return null;
  }
}

export async function materializeAdmins(
  mode: AuthMode,
  admins: string[],
  store: AdminGrantStore,
): Promise<MaterializeResult> {
  if (mode === "none") {
    return { created: 0, revoked: 0, reactivated: 0, unchanged: 0 };
  }

  const result: MaterializeResult = {
    created: 0,
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

    const existing = configGrants.get(instanceName);

    if (existing && existing.grant.state === "active") {
      result.unchanged++;
      continue;
    }

    if (existing && existing.grant.state === "revoked") {
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

  for (const [instanceName, { grant, modelId }] of configGrants) {
    if (desiredInstanceNames.has(instanceName)) continue;
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

  return result;
}
