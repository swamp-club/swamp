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

import { useMemo } from "react";
import { useRequest } from "./useRequest.ts";
import { extractSortedByName } from "./sorted_by_name.ts";
import type { HealthSnapshot } from "./useHealthStream.ts";
import {
  facetIndex,
  prefixOptions,
  type WorkflowFacets,
  type WorkflowRef,
} from "../lib/workflow_facets.ts";

export interface CatalogWorkflow extends WorkflowRef {
  id: string;
  name: string;
  description?: string;
  stepCount?: number;
  jobCount?: number;
  trigger?: { schedule?: string };
}

export interface WorkflowCatalog {
  workflows: CatalogWorkflow[];
  byName: Map<string, CatalogWorkflow>;
  loading: boolean;
  error: string | null;
  facetsOf: (workflow: WorkflowRef) => WorkflowFacets;
  prefixes: Array<{ prefix: string; count: number }>;
  /** Every webhook route, sorted. */
  webhookRoutes: string[];
}

/**
 * Every workflow the token can read, with the facets (prefix, schedule,
 * webhooks) the filter bar slices on. Schedules and webhooks come from the
 * health stream, so they reflect serve's effective configuration
 * (overrides included), not just the workflow files.
 */
export function useWorkflowCatalog(
  health: HealthSnapshot | null,
): WorkflowCatalog {
  const { data, loading, error } = useRequest("workflow.search", {});
  const workflows = useMemo(() => extractSortedByName<CatalogWorkflow>(data), [
    data,
  ]);
  const schedules = health?.scheduling?.schedules;
  const webhooks = health?.webhooks;
  const facetsOf = useMemo(
    () => facetIndex({ scheduled: schedules, webhooks }),
    [schedules, webhooks],
  );
  return useMemo(() => ({
    workflows,
    byName: new Map(workflows.map((w) => [w.name, w])),
    loading: loading && data === null,
    error,
    facetsOf,
    prefixes: prefixOptions(workflows.map((w) => w.name)),
    webhookRoutes: [...new Set((webhooks ?? []).map((w) => w.route))].sort(),
  }), [workflows, loading, data, error, facetsOf, webhooks]);
}
