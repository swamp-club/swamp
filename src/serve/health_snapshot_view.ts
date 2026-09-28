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

import type { ReadAuthorizer } from "./admin_auth.ts";
import type { HealthSnapshot } from "./health_collector.ts";

/**
 * The health snapshot as one reader may see it. Admins get it whole. Anyone
 * else sees the runs, schedules and webhooks of the workflows and models they
 * may read, without who started each run, and none of the worker or component
 * detail, which describes the deployment rather than any resource. Instance
 * status, uptime and aggregate run metrics stay visible to every reader.
 */
export function healthSnapshotFor(
  snapshot: HealthSnapshot,
  reader: ReadAuthorizer,
): HealthSnapshot {
  if (reader.isAdmin()) return snapshot;
  const readsWorkflow = (name: string) =>
    reader.canRead({ kind: "workflow", name, fields: { name } });
  return {
    ...snapshot,
    activeRuns: snapshot.activeRuns
      .filter((run) =>
        run.kind === "method-run"
          ? reader.canRead({
            kind: "model",
            name: run.resourceName,
            fields: { name: run.resourceName },
          })
          : readsWorkflow(run.resourceName)
      )
      .map((run) => ({ ...run, principalId: null })),
    workers: [],
    scheduling: {
      ...snapshot.scheduling,
      schedules: snapshot.scheduling.schedules.filter((schedule) =>
        readsWorkflow(schedule.workflowName)
      ),
    },
    webhooks: snapshot.webhooks.filter((webhook) =>
      readsWorkflow(webhook.workflow)
    ),
    components: [],
  };
}
