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
import type { GrantFileEntry } from "./grant_file.ts";
import { isFileSource, parseFileSourceFilename } from "./grant_source.ts";
import { subjectToString } from "./subject.ts";
import { resourceSelectorToString } from "./resource_selector.ts";
import type { MaterializeResult } from "./admin_materializer.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { Definition } from "../definitions/definition.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { createResourceWriter } from "../models/data_writer.ts";

const logger = getLogger(["swamp", "grant-file-reconciler"]);

export interface FileGrantStore {
  queryFileGrants(): Promise<
    Map<string, { grant: Grant; modelId: string; instanceName: string }>
  >;
  ensureDefinition(instanceName: string): Promise<string>;
  writeGrant(
    modelId: string,
    instanceName: string,
    grant: Grant,
  ): Promise<void>;
}

function entryIdentityKey(entry: GrantFileEntry): string {
  const subject = `${entry.subject.kind}:${entry.subject.name}`;
  const actions = [...entry.actions].sort().join(",");
  const resource = `${entry.resource.kind}:${entry.resource.pattern}`;
  const condition = entry.condition?.trim() ?? "";
  return `${subject}|${entry.effect}|${actions}|${resource}|${condition}`;
}

function grantIdentityKey(grant: Grant): string {
  const subject = `${grant.subject.kind}:${grant.subject.name}`;
  const actions = [...grant.actions].sort().join(",");
  const resource = `${grant.resource.kind}:${grant.resource.pattern}`;
  const condition = grant.condition?.trim() ?? "";
  return `${subject}|${grant.effect}|${actions}|${resource}|${condition}`;
}

function buildFileGrant(entry: GrantFileEntry, filename: string): Grant {
  return {
    id: crypto.randomUUID(),
    subject: entry.subject,
    effect: entry.effect,
    actions: entry.actions,
    resource: entry.resource,
    condition: entry.condition,
    state: "active",
    source: `file:${filename}`,
    createdBy: { kind: "user", id: "system" },
    createdAt: new Date().toISOString(),
  };
}

export async function reconcileFileGrants(
  filename: string,
  entries: GrantFileEntry[],
  store: FileGrantStore,
): Promise<MaterializeResult> {
  const result: MaterializeResult = {
    created: 0,
    revoked: 0,
    reactivated: 0,
    unchanged: 0,
  };

  const allFileGrants = await store.queryFileGrants();

  const grantsForFile = new Map<
    string,
    { grant: Grant; modelId: string; instanceName: string; key: string }
  >();
  for (const [_id, entry] of allFileGrants) {
    if (
      isFileSource(entry.grant.source) &&
      parseFileSourceFilename(entry.grant.source) === filename
    ) {
      const key = grantIdentityKey(entry.grant);
      grantsForFile.set(key, { ...entry, key });
    }
  }

  const desiredKeys = new Set<string>();

  for (const entry of entries) {
    const key = entryIdentityKey(entry);
    desiredKeys.add(key);

    const existing = grantsForFile.get(key);

    if (existing && existing.grant.state === "active") {
      result.unchanged++;
      continue;
    }

    if (existing && existing.grant.state === "revoked") {
      const reactivated: Grant = { ...existing.grant, state: "active" };
      await store.writeGrant(
        existing.modelId,
        existing.instanceName,
        reactivated,
      );
      result.reactivated++;
      const subjectStr = subjectToString(entry.subject);
      const resourceStr = resourceSelectorToString(entry.resource);
      logger
        .info`Re-activated file grant for ${subjectStr} on ${resourceStr} from ${filename}`;
      continue;
    }

    const instanceName = `grant-file-${crypto.randomUUID().slice(0, 16)}`;
    const modelId = await store.ensureDefinition(instanceName);
    const grant = buildFileGrant(entry, filename);
    await store.writeGrant(modelId, instanceName, grant);
    result.created++;
    const subjectStr = subjectToString(entry.subject);
    const resourceStr = resourceSelectorToString(entry.resource);
    logger
      .info`Created file grant for ${subjectStr} on ${resourceStr} from ${filename}`;
  }

  for (const [key, { grant, modelId, instanceName }] of grantsForFile) {
    if (desiredKeys.has(key)) continue;
    if (grant.state === "revoked") {
      result.unchanged++;
      continue;
    }

    const revoked: Grant = { ...grant, state: "revoked" };
    await store.writeGrant(modelId, instanceName, revoked);
    const subjectStr = subjectToString(grant.subject);
    const resourceStr = resourceSelectorToString(grant.resource);
    result.revoked++;
    logger
      .info`Revoked file grant for ${subjectStr} on ${resourceStr} from ${filename}`;
  }

  return result;
}

export interface ReconcileAllResult {
  totalCreated: number;
  totalRevoked: number;
  totalReactivated: number;
  totalUnchanged: number;
  filesProcessed: number;
  perFile: Map<string, MaterializeResult>;
}

export async function reconcileAllFileGrants(
  fileEntries: Map<string, GrantFileEntry[]>,
  store: FileGrantStore,
): Promise<ReconcileAllResult> {
  const perFile = new Map<string, MaterializeResult>();
  let totalCreated = 0;
  let totalRevoked = 0;
  let totalReactivated = 0;
  let totalUnchanged = 0;

  for (const [filename, entries] of fileEntries) {
    const result = await reconcileFileGrants(filename, entries, store);
    perFile.set(filename, result);
    totalCreated += result.created;
    totalRevoked += result.revoked;
    totalReactivated += result.reactivated;
    totalUnchanged += result.unchanged;
  }

  return {
    totalCreated,
    totalRevoked,
    totalReactivated,
    totalUnchanged,
    filesProcessed: fileEntries.size,
    perFile,
  };
}

const GRANT_DATA_NAME = "grant-main";

export function createFileGrantStore(
  readRepo: DefinitionRepository,
  writeRepo: DefinitionRepository,
  dataRepo: UnifiedDataRepository,
): FileGrantStore {
  return {
    async queryFileGrants() {
      const grantDataItems = await dataRepo.findAllForType(GRANT_MODEL_TYPE);

      const fileGrants = new Map<
        string,
        { grant: Grant; modelId: string; instanceName: string }
      >();
      for (const { data, modelType, modelId } of grantDataItems) {
        const content = await dataRepo.getContent(
          modelType,
          modelId,
          data.name,
        );
        if (!content) continue;
        let attrs: Record<string, unknown>;
        try {
          attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
            string,
            unknown
          >;
        } catch {
          continue;
        }
        const parsed = GrantSchema.safeParse(attrs);
        if (parsed.success && isFileSource(parsed.data.source)) {
          const modelName = data.tags["modelName"] ?? "";
          fileGrants.set(modelName, {
            grant: parsed.data,
            modelId,
            instanceName: modelName,
          });
        }
      }
      return fileGrants;
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
        });
        await writeRepo.save(GRANT_MODEL_TYPE, def);
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
