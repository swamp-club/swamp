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

import type { AccessResource } from "../domain/access/mod.ts";
import type { DefinitionRepository } from "../domain/definitions/repositories.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import type { WorkflowRepository } from "../domain/workflows/repositories.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import type { ReadAuthorizer } from "./admin_auth.ts";
import type { HealthSnapshot } from "./health_collector.ts";

/**
 * Turns the workflow or model a health entry names, by id or name, into the
 * access resource a read is decided on: its real name plus the fields grants
 * match (tags, and a model's type). Null when it cannot be found.
 */
export interface HealthResourceResolver {
  workflow(idOrName: string): Promise<AccessResource | null>;
  model(idOrName: string): Promise<AccessResource | null>;
}

/** Resolves health entries with the same fields the WebSocket handlers use. */
export function createHealthResourceResolver(repos: {
  workflowRepo: WorkflowRepository;
  definitionRepo: DefinitionRepository;
}): HealthResourceResolver {
  return {
    async workflow(idOrName) {
      try {
        const workflow = await repos.workflowRepo.findByName(idOrName) ??
          await repos.workflowRepo.findById(createWorkflowId(idOrName));
        if (!workflow) return null;
        const fields: Record<string, unknown> = { name: workflow.name };
        const tags = workflow.tags;
        if (tags && Object.keys(tags).length > 0) fields.tags = tags;
        return { kind: "workflow", name: workflow.name, fields };
      } catch {
        return null;
      }
    },
    async model(idOrName) {
      try {
        const found = await findDefinitionByIdOrName(
          repos.definitionRepo,
          idOrName,
        );
        if (!found) return null;
        const fields: Record<string, unknown> = {
          name: found.definition.name,
          modelType: found.type.normalized,
        };
        const tags = found.definition.tags;
        if (tags && Object.keys(tags).length > 0) fields.tags = tags;
        return { kind: "model", name: found.definition.name, fields };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The health snapshot as one reader may see it. Admins get it whole. Anyone
 * else sees the runs, schedules and webhooks of the workflows and models they
 * may read, without who started each run, and none of the worker or component
 * detail, which describes the deployment rather than any resource. An entry
 * whose workflow or model cannot be resolved is hidden. Instance status,
 * uptime and aggregate run metrics stay visible to every reader.
 */
export async function healthSnapshotFor(
  snapshot: HealthSnapshot,
  reader: ReadAuthorizer,
  resolver: HealthResourceResolver,
): Promise<HealthSnapshot> {
  if (reader.isAdmin()) return snapshot;

  const decided = new Map<string, Promise<boolean>>();
  const reads = (kind: "workflow" | "model", idOrName: string) => {
    const key = `${kind}:${idOrName}`;
    let result = decided.get(key);
    if (!result) {
      result = resolver[kind](idOrName).then((resource) =>
        resource !== null && reader.canRead(resource)
      );
      decided.set(key, result);
    }
    return result;
  };
  const keep = async <T>(
    items: readonly T[],
    readable: (item: T) => Promise<boolean>,
  ): Promise<T[]> => {
    const verdicts = await Promise.all(items.map(readable));
    return items.filter((_, i) => verdicts[i]);
  };

  const [activeRuns, schedules, webhooks] = await Promise.all([
    keep(
      snapshot.activeRuns,
      (run) =>
        reads(
          run.kind === "method-run" ? "model" : "workflow",
          run.resourceName,
        ),
    ),
    keep(
      snapshot.scheduling.schedules,
      (schedule) => reads("workflow", schedule.workflowName),
    ),
    keep(snapshot.webhooks, (webhook) => reads("workflow", webhook.workflow)),
  ]);

  return {
    ...snapshot,
    activeRuns: activeRuns.map((run) => ({ ...run, principalId: null })),
    workers: [],
    scheduling: { ...snapshot.scheduling, schedules },
    webhooks,
    components: [],
  };
}
