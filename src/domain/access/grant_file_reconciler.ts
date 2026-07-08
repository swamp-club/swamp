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
import { entryIdentityKey, type GrantFileEntry } from "./grant_file.ts";
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

interface StoredFileGrant {
  grant: Grant;
  modelId: string;
  instanceName: string;
}

function groupByFilename(
  allFileGrants: Map<string, StoredFileGrant>,
): Map<string, Map<string, StoredFileGrant>> {
  const byFile = new Map<string, Map<string, StoredFileGrant>>();
  for (const [_id, entry] of allFileGrants) {
    if (!isFileSource(entry.grant.source)) continue;
    const filename = parseFileSourceFilename(entry.grant.source);
    let fileMap = byFile.get(filename);
    if (!fileMap) {
      fileMap = new Map();
      byFile.set(filename, fileMap);
    }
    const key = grantIdentityKey(entry.grant);
    fileMap.set(key, entry);
  }
  return byFile;
}

function reconcileOneFile(
  filename: string,
  entries: GrantFileEntry[],
  grantsForFile: Map<string, StoredFileGrant>,
  store: FileGrantStore,
): { result: MaterializeResult; writes: Promise<void>[] } {
  const result: MaterializeResult = {
    created: 0,
    revoked: 0,
    reactivated: 0,
    unchanged: 0,
  };
  const writes: Promise<void>[] = [];
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
      writes.push(
        store.writeGrant(
          existing.modelId,
          existing.instanceName,
          reactivated,
        ),
      );
      result.reactivated++;
      const subjectStr = subjectToString(entry.subject);
      const resourceStr = resourceSelectorToString(entry.resource);
      logger
        .info`Re-activated file grant for ${subjectStr} on ${resourceStr} from ${filename}`;
      continue;
    }

    const instanceName = `grant-file-${crypto.randomUUID().slice(0, 16)}`;
    writes.push(
      store.ensureDefinition(instanceName).then((modelId) => {
        const grant = buildFileGrant(entry, filename);
        return store.writeGrant(modelId, instanceName, grant);
      }),
    );
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
    writes.push(store.writeGrant(modelId, instanceName, revoked));
    const subjectStr = subjectToString(grant.subject);
    const resourceStr = resourceSelectorToString(grant.resource);
    result.revoked++;
    logger
      .info`Revoked file grant for ${subjectStr} on ${resourceStr} from ${filename}`;
  }

  return { result, writes };
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
  const allFileGrants = await store.queryFileGrants();
  const grantsByFile = groupByFilename(allFileGrants);

  const perFile = new Map<string, MaterializeResult>();
  const allWrites: Promise<void>[] = [];
  let totalCreated = 0;
  let totalRevoked = 0;
  let totalReactivated = 0;
  let totalUnchanged = 0;

  for (const [filename, entries] of fileEntries) {
    const grantsForFile = grantsByFile.get(filename) ?? new Map();
    const { result, writes } = reconcileOneFile(
      filename,
      entries,
      grantsForFile,
      store,
    );
    perFile.set(filename, result);
    allWrites.push(...writes);
    totalCreated += result.created;
    totalRevoked += result.revoked;
    totalReactivated += result.reactivated;
    totalUnchanged += result.unchanged;
  }

  for (const [filename, grantsForFile] of grantsByFile) {
    if (fileEntries.has(filename)) continue;
    const { result, writes } = reconcileOneFile(
      filename,
      [],
      grantsForFile,
      store,
    );
    perFile.set(filename, result);
    allWrites.push(...writes);
    totalCreated += result.created;
    totalRevoked += result.revoked;
    totalReactivated += result.reactivated;
    totalUnchanged += result.unchanged;
  }

  await Promise.all(allWrites);

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
          fileGrants.set(modelId, {
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
