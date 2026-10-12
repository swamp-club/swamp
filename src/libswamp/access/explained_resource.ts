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
 * The resource an access check explains. This is a resolution helper used
 * inside commands, not a user-facing operation, so it returns a value rather
 * than an event stream (swamp-club#3224).
 */

import {
  type AccessResource,
  kindResource,
} from "../../domain/access/access_decision_service.ts";
import {
  modelAccessResource,
  unresolvedAccessResource,
  vaultKindResource,
  workflowAccessResource,
} from "../../domain/access/access_resources.ts";
import type { ResourceKind } from "../../domain/access/resource_selector.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { findWorkflowByIdOrName } from "../../domain/workflows/workflow_lookup.ts";
import {
  findVaultByNameOrId,
  type VaultEditLookupDeps,
} from "../vaults/edit.ts";

/** The repositories an access check resolves a named resource through. */
export interface ExplainedResourceDeps {
  readonly definitionRepo: DefinitionRepository;
  readonly workflowRepo: Pick<WorkflowRepository, "findByName" | "findById">;
  readonly vaultConfigRepo: VaultEditLookupDeps;
}

/**
 * The resource an access check explains, judged as a request would judge it
 * (swamp-club#2675). A concrete model, data or workflow name is resolved to
 * the resource it names, with all of its fields, so a grant on its type or a
 * condition on its tags decides as it would for a request; a name that
 * matches nothing is a resource with no tags. A pattern with a wildcard, or
 * an access resource, names no single resource and is explained as a check
 * on the kind. A vault is explained by the name it resolves to.
 *
 * `extraFields` are merged over the resolved fields, a map one level deep,
 * so a simulated `tags.env` replaces that one tag and keeps the others.
 * `onLookupError` hears a lookup that failed; the resource is then explained
 * by its name alone, so conditions on anything else fail closed.
 *
 * Serve's access check and the local `swamp access check` both explain
 * through here, so they give the same answer for the same repo
 * (swamp-club#3224).
 */
export async function explainedAccessResource(
  deps: ExplainedResourceDeps,
  kind: ResourceKind,
  pattern: string,
  extraFields: Record<string, unknown> = {},
  onLookupError?: (error: unknown) => void,
): Promise<AccessResource> {
  const resource = await resolvedResource(deps, kind, pattern, onLookupError);
  return { ...resource, fields: mergeFields(resource.fields, extraFields) };
}

async function resolvedResource(
  deps: ExplainedResourceDeps,
  kind: ResourceKind,
  pattern: string,
  onLookupError: ((error: unknown) => void) | undefined,
): Promise<AccessResource> {
  if (kind === "access" || pattern.includes("*")) {
    return { ...kindResource(kind), name: pattern };
  }
  if (kind === "vault") {
    let name = pattern;
    try {
      const resolved = await findVaultByNameOrId(deps.vaultConfigRepo, pattern);
      if (resolved) name = resolved.name;
    } catch (error) {
      // A vault that cannot be loaded is explained by the requested name.
      onLookupError?.(error);
    }
    return vaultKindResource(name);
  }
  try {
    if (kind === "workflow") {
      const workflow = await findWorkflowByIdOrName(deps.workflowRepo, pattern);
      return workflow
        ? workflowAccessResource(workflow)
        : unresolvedAccessResource(kind, pattern);
    }
    const result = await findDefinitionByIdOrName(deps.definitionRepo, pattern);
    return result
      ? modelAccessResource(result, kind)
      : unresolvedAccessResource(kind, pattern);
  } catch (error) {
    // Only the name is known, so conditions on anything else fail closed.
    onLookupError?.(error);
    return { kind, name: pattern, fields: { name: pattern } };
  }
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeFields(
  resolved: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...resolved };
  for (const [key, value] of Object.entries(extra)) {
    const current = merged[key];
    merged[key] = isPlainMap(current) && isPlainMap(value)
      ? { ...current, ...value }
      : value;
  }
  return merged;
}
