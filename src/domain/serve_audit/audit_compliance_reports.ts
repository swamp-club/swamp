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

import type { ChainedAuditEvent } from "./audit_event.ts";
import type { AuditQueryService } from "./audit_query_service.ts";

export interface ComplianceReportParams {
  readonly from: string;
  readonly to: string;
}

export interface ComplianceReportResult {
  readonly name: string;
  readonly description: string;
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly markdown: string;
  readonly json: Record<string, unknown>;
}

export interface ComplianceReportDefinition {
  readonly name: string;
  readonly description: string;
  execute(
    queryService: AuditQueryService,
    params: ComplianceReportParams,
  ): Promise<ComplianceReportResult>;
}

function groupBy<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

async function collectEvents(
  queryService: AuditQueryService,
  params: ComplianceReportParams,
  filters: {
    category?: string;
    action?: string;
    outcome?: string;
  },
): Promise<ChainedAuditEvent[]> {
  const result = await queryService.query({
    since: params.from,
    until: params.to,
    category: filters.category,
    action: filters.action,
    outcome: filters.outcome,
    export: true,
  });
  return result.events as ChainedAuditEvent[];
}

function buildResult(
  name: string,
  description: string,
  params: ComplianceReportParams,
  markdown: string,
  json: Record<string, unknown>,
): ComplianceReportResult {
  return {
    name,
    description,
    from: params.from,
    to: params.to,
    generatedAt: new Date().toISOString(),
    markdown,
    json,
  };
}

export const accessReviewReport: ComplianceReportDefinition = {
  name: "access-review",
  description:
    "Who has access to what, based on grant events and current policy state.",
  async execute(queryService, params) {
    const events = await collectEvents(queryService, params, {
      category: "access",
    });

    const byPrincipal = groupBy(events, (e) => e.principalId);
    const lines: string[] = [
      `# Access Review Report`,
      ``,
      `**Period:** ${params.from} to ${params.to}`,
      `**Total events:** ${events.length}`,
      `**Unique principals:** ${byPrincipal.size}`,
      ``,
    ];

    const principals: Record<string, unknown>[] = [];
    for (const [principalId, principalEvents] of byPrincipal) {
      const lastEvent = principalEvents[principalEvents.length - 1];
      const resources = new Set(
        principalEvents.map((e) => `${e.resourceKind}:${e.resourceName}`),
      );
      const actions = new Set(principalEvents.map((e) => e.action));

      lines.push(`## ${principalId}`);
      lines.push(``);
      lines.push(`- **Events:** ${principalEvents.length}`);
      lines.push(`- **Last activity:** ${lastEvent.timestamp}`);
      lines.push(`- **Resources accessed:** ${[...resources].join(", ")}`);
      lines.push(`- **Actions:** ${[...actions].join(", ")}`);
      lines.push(``);

      principals.push({
        principalId,
        eventCount: principalEvents.length,
        lastActivity: lastEvent.timestamp,
        resources: [...resources],
        actions: [...actions],
      });
    }

    return buildResult(
      "access-review",
      "Access review report",
      params,
      lines.join("\n"),
      { principals, totalEvents: events.length },
    );
  },
};

export const secretAccessReport: ComplianceReportDefinition = {
  name: "secret-access",
  description: "Every vault.read-secret event, grouped by principal and key.",
  async execute(queryService, params) {
    const events = await collectEvents(queryService, params, {
      category: "secrets",
      action: "vault.read-secret",
    });

    const byPrincipal = groupBy(events, (e) => e.principalId);
    const lines: string[] = [
      `# Secret Access Log`,
      ``,
      `**Period:** ${params.from} to ${params.to}`,
      `**Total accesses:** ${events.length}`,
      `**Unique principals:** ${byPrincipal.size}`,
      ``,
    ];

    const accesses: Record<string, unknown>[] = [];
    for (const [principalId, principalEvents] of byPrincipal) {
      const byResource = groupBy(
        principalEvents,
        (e) => e.resourceName,
      );

      lines.push(`## ${principalId}`);
      lines.push(``);
      for (const [resourceName, resourceEvents] of byResource) {
        lines.push(
          `- **${resourceName}**: ${resourceEvents.length} access(es), last at ${
            resourceEvents[resourceEvents.length - 1].timestamp
          }`,
        );
      }
      lines.push(``);

      accesses.push({
        principalId,
        totalAccesses: principalEvents.length,
        resources: [...byResource.entries()].map(([name, evts]) => ({
          resourceName: name,
          accessCount: evts.length,
          lastAccess: evts[evts.length - 1].timestamp,
        })),
      });
    }

    return buildResult(
      "secret-access",
      "Secret access log",
      params,
      lines.join("\n"),
      { accesses, totalAccesses: events.length },
    );
  },
};

export const changeHistoryReport: ComplianceReportDefinition = {
  name: "change-history",
  description:
    "All configuration changes (create/edit/delete) in a time range.",
  async execute(queryService, params) {
    const allEvents = await collectEvents(queryService, params, {});
    const mutatingActions = new Set([
      "create",
      "edit",
      "delete",
      "update",
      "put",
      "remove",
    ]);
    const events = allEvents.filter((e) => {
      const actionVerb = e.action.split(".").pop() ?? "";
      return mutatingActions.has(actionVerb);
    });

    const lines: string[] = [
      `# Change History Report`,
      ``,
      `**Period:** ${params.from} to ${params.to}`,
      `**Total changes:** ${events.length}`,
      ``,
      `| Timestamp | Principal | Action | Resource | Outcome |`,
      `| --------- | --------- | ------ | -------- | ------- |`,
    ];

    const changes: Record<string, unknown>[] = [];
    for (const event of events) {
      lines.push(
        `| ${event.timestamp} | ${event.principalId} | ${event.action} | ${event.resourceKind}:${event.resourceName} | ${event.outcome} |`,
      );
      changes.push({
        timestamp: event.timestamp,
        principalId: event.principalId,
        action: event.action,
        resourceKind: event.resourceKind,
        resourceName: event.resourceName,
        outcome: event.outcome,
      });
    }

    return buildResult(
      "change-history",
      "Change history report",
      params,
      lines.join("\n"),
      { changes, totalChanges: events.length },
    );
  },
};

export const deniedAccessReport: ComplianceReportDefinition = {
  name: "denied-access",
  description: "All denied events grouped by principal, rule, and resource.",
  async execute(queryService, params) {
    const events = await collectEvents(queryService, params, {
      outcome: "denied",
    });

    const byPrincipal = groupBy(events, (e) => e.principalId);
    const lines: string[] = [
      `# Denied Access Report`,
      ``,
      `**Period:** ${params.from} to ${params.to}`,
      `**Total denials:** ${events.length}`,
      `**Unique principals:** ${byPrincipal.size}`,
      ``,
    ];

    const denials: Record<string, unknown>[] = [];
    for (const [principalId, principalEvents] of byPrincipal) {
      const byResource = groupBy(
        principalEvents,
        (e) => `${e.resourceKind}:${e.resourceName}`,
      );

      lines.push(`## ${principalId} (${principalEvents.length} denial(s))`);
      lines.push(``);
      for (const [resource, resourceEvents] of byResource) {
        const actions = new Set(resourceEvents.map((e) => e.action));
        lines.push(
          `- **${resource}**: ${resourceEvents.length} denial(s) — actions: ${
            [...actions].join(", ")
          }`,
        );
      }
      lines.push(``);

      denials.push({
        principalId,
        totalDenials: principalEvents.length,
        resources: [...byResource.entries()].map(([res, evts]) => ({
          resource: res,
          denialCount: evts.length,
          actions: [...new Set(evts.map((e) => e.action))],
        })),
      });
    }

    return buildResult(
      "denied-access",
      "Denied access report",
      params,
      lines.join("\n"),
      { denials, totalDenials: events.length },
    );
  },
};

export const systemEventsReport: ComplianceReportDefinition = {
  name: "system-events",
  description: "All system-category events (lifecycle, health, HA, alerts).",
  async execute(queryService, params) {
    const events = await collectEvents(queryService, params, {
      category: "system",
    });

    const byAction = groupBy(events, (e) => e.action);
    const lines: string[] = [
      `# System Event Log`,
      ``,
      `**Period:** ${params.from} to ${params.to}`,
      `**Total events:** ${events.length}`,
      `**Unique actions:** ${byAction.size}`,
      ``,
      `| Timestamp | Action | Instance | Outcome | Detail |`,
      `| --------- | ------ | -------- | ------- | ------ |`,
    ];

    const systemEvents: Record<string, unknown>[] = [];
    for (const event of events) {
      lines.push(
        `| ${event.timestamp} | ${event.action} | ${event.instanceId} | ${event.outcome} | ${
          event.detail ?? ""
        } |`,
      );
      systemEvents.push({
        timestamp: event.timestamp,
        action: event.action,
        instanceId: event.instanceId,
        outcome: event.outcome,
        detail: event.detail,
      });
    }

    return buildResult(
      "system-events",
      "System event log",
      params,
      lines.join("\n"),
      {
        events: systemEvents,
        totalEvents: events.length,
        actionSummary: [...byAction.entries()].map(([action, evts]) => ({
          action,
          count: evts.length,
        })),
      },
    );
  },
};

export const COMPLIANCE_REPORTS: readonly ComplianceReportDefinition[] = [
  accessReviewReport,
  secretAccessReport,
  changeHistoryReport,
  deniedAccessReport,
  systemEventsReport,
];

export function getComplianceReport(
  name: string,
): ComplianceReportDefinition | undefined {
  return COMPLIANCE_REPORTS.find((r) => r.name === name);
}
