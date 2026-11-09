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
 * resolves to the access resource a read is decided on: real name plus the
 * fields grants match; null when not found
 */
export interface HealthResourceResolver {
  workflow(idOrName: string): Promise<AccessResource | null>;
  model(idOrName: string): Promise<AccessResource | null>;
}

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

const MAX_CACHED_HEALTH_RESOURCES = 1024;

export interface CachedHealthResourceResolverOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
}

/**
 * reuses only the resource, never a read decision, so a tag edit can take up to
 * ttlMs to change what a reader sees; access changes are unaffected since they
 * end the principal's health streams
 */
export function cachedHealthResourceResolver(
  inner: HealthResourceResolver,
  options: CachedHealthResourceResolverOptions,
): HealthResourceResolver {
  const now = options.now ?? (() => performance.now());
  const entries = new Map<
    string,
    { resource: Promise<AccessResource | null>; resolvedAt: number }
  >();
  // A negative age means the clock went backwards: treat it as expired.
  const fresh = (resolvedAt: number, at: number) => {
    const age = at - resolvedAt;
    return age >= 0 && age < options.ttlMs;
  };

  const resolve = (
    kind: "workflow" | "model",
    idOrName: string,
  ): Promise<AccessResource | null> => {
    const key = `${kind}:${idOrName}`;
    const at = now();
    const entry = entries.get(key);
    if (entry && fresh(entry.resolvedAt, at)) return entry.resource;

    if (entries.size >= MAX_CACHED_HEALTH_RESOURCES) {
      for (const [k, e] of entries) {
        if (!fresh(e.resolvedAt, at)) entries.delete(k);
      }
      if (entries.size >= MAX_CACHED_HEALTH_RESOURCES) entries.clear();
    }

    const cached = {
      resource: inner[kind](idOrName).catch((error: unknown) => {
        if (entries.get(key) === cached) entries.delete(key);
        throw error;
      }),
      resolvedAt: at,
    };
    entries.set(key, cached);
    return cached.resource;
  };

  return {
    workflow: (idOrName) => resolve("workflow", idOrName),
    model: (idOrName) => resolve("model", idOrName),
  };
}

/**
 * non-admins see only entries for workflows and models they may read, without
 * who started each run and without worker or component detail; unresolvable
 * entries are hidden
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

  // Retention and route files describe the deployment, like components:
  // admins only.
  const {
    retention: _retention,
    webhookRouteFiles: _webhookRouteFiles,
    ...shared
  } = snapshot;
  return {
    ...shared,
    activeRuns: activeRuns.map((run) => ({ ...run, principalId: null })),
    workers: [],
    // The scheduler's time zone is a deployment detail: only a reader who
    // sees a schedule gets it, to read that schedule's fire times.
    scheduling: schedules.length > 0
      ? { ...snapshot.scheduling, schedules }
      : { enabled: snapshot.scheduling.enabled, schedules },
    webhooks,
    components: [],
  };
}
