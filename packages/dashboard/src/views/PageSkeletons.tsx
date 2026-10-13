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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import type { ReactNode } from "react";
import {
  Skeleton,
  SkeletonChart,
  type SkeletonColumn,
  SkeletonKeyValues,
  SkeletonRegion,
  SkeletonTable,
  widthAt,
} from "../components/Skeleton.tsx";
import { HealthUnavailable } from "../components/HealthUnavailable.tsx";

// Loading states for the Overview, Data, Data detail, Vaults, Extensions,
// System and Login pages. Each is the loaded layout with placeholders where
// the data goes — same grid, same panels, real titles and column headers —
// so nothing moves when the answer lands. Views keep their tables' headers
// in the column lists below so the skeleton and the table never drift.
// This module imports nothing that needs a bundler, so every skeleton is
// render-tested in PageSkeletons_test.tsx.

// ── Overview ───────────────────────────────────────────────────────────

const CHART_LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["Succeeded", "var(--chart-bar-1)"],
  ["Failed", "var(--chart-bar-2)"],
  ["Cancelled", "var(--chart-bar-5)"],
  ["Running / waiting", "var(--chart-bar-4)"],
];

/** The Executions chart's panel: title, legend, and the plot area. */
export function ExecutionChartFrame({ children }: { children: ReactNode }) {
  return (
    <div className="chart-section">
      <div className="chart-header">
        <span className="chart-title">Executions</span>
        <div className="chart-legend">
          {CHART_LEGEND.map(([label, color]) => (
            <span key={label}>
              <span className="legend-dot" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

/** The Executions chart while runs load: a bar-chart silhouette. */
export function ExecutionChartSkeleton() {
  return (
    <ExecutionChartFrame>
      <SkeletonRegion label="Loading executions chart" className="chart-area">
        <SkeletonChart bars={7} height="100%" />
      </SkeletonRegion>
    </ExecutionChartFrame>
  );
}

/** A stat card's value while its source loads. */
export function StatValueSkeleton({ width = 80 }: { width?: number }) {
  return <Skeleton width={width} height={26} radius={6} />;
}

/** Upcoming Schedules rows: name, cron badge, next-fire time. */
export function ScheduleRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <>
      {Array.from(
        { length: rows },
        (_, i) => (
          <div className="schedule-row" key={i}>
            <Skeleton width={widthAt(i)} height={11} />
            <Skeleton width={84} height={18} radius={4} />
            <Skeleton width={44} height={10} />
          </div>
        ),
      )}
    </>
  );
}

/** The Upcoming Schedules panel body until the health stream delivers. */
export function UpcomingSchedulesSkeleton() {
  return (
    <HealthUnavailable
      state="loading"
      subject="schedules"
      skeleton={<ScheduleRowsSkeleton />}
    />
  );
}

/** The panel-title count badge while its list loads. */
export function CountSkeleton() {
  return <Skeleton width={22} height={14} radius={10} />;
}

// ── Data ───────────────────────────────────────────────────────────────

export const DATA_COLUMNS: SkeletonColumn[] = [
  { header: "Name" },
  { header: "Model", cell: 110 },
  { header: "Type", cell: 56 },
  { header: "Content Type", cell: 120 },
  { header: "Version", cell: 32 },
];

export function DataTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <SkeletonTable columns={DATA_COLUMNS} rows={rows} label="Loading data" />
  );
}

// ── Extensions ─────────────────────────────────────────────────────────

export const EXTENSION_COLUMNS: SkeletonColumn[] = [
  { header: "Extension" },
  { header: "Version", cell: 56 },
  { header: "Channel", cell: 48 },
  { header: "Status", cell: "pill" },
];

export function ExtensionsTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <SkeletonTable
      columns={EXTENSION_COLUMNS}
      rows={rows}
      label="Loading extensions"
    />
  );
}

// ── Vaults ─────────────────────────────────────────────────────────────

/** The vault list: collapsed vault panels with a name and type badge. */
export function VaultListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonRegion
      label="Loading vaults"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div className="panel" key={i}>
          <div
            className="panel-header"
            style={{ justifyContent: "start", borderBottom: "none" }}
          >
            <span className="panel-title">
              <Skeleton width={8} height={8} radius={2} />
              <Skeleton width={i % 2 ? 96 : 132} height={13} />
              <Skeleton width={104} height={18} radius={4} />
            </span>
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

// Matches the expanded vault's key and activity rows.
const VAULT_ROW_STYLE = {
  padding: "8px 18px",
  display: "flex",
  alignItems: "center",
  gap: 10,
  borderBottom: "1px solid var(--border-subtle)",
} as const;

/** One section of an expanded vault (configuration, keys, activity). */
export function VaultSectionSkeleton(
  { label, rows = 3, badge = false }: {
    label: string;
    rows?: number;
    /** Rows lead with a badge (the audit trail's action). */
    badge?: boolean;
  },
) {
  return (
    <SkeletonRegion label={label}>
      {Array.from(
        { length: rows },
        (_, i) => (
          <div style={VAULT_ROW_STYLE} key={i}>
            {badge && <Skeleton width={52} height={16} radius={4} />}
            <Skeleton width={i % 2 ? 110 : 150} height={10} />
            <Skeleton
              width={badge ? 40 : 80}
              height={badge ? 9 : 10}
              style={{ marginLeft: "auto" }}
            />
          </div>
        ),
      )}
    </SkeletonRegion>
  );
}

// ── System ─────────────────────────────────────────────────────────────

export const CLUSTER_COLUMNS: SkeletonColumn[] = [
  { header: "Instance", cell: 120 },
  { header: "Status", cell: "pill" },
  { header: "Uptime", cell: "mono" },
  { header: "Active Runs", cell: 24 },
  { header: "Throughput", cell: "mono" },
  { header: "P95 Latency", cell: 40 },
  { header: "Workers", cell: 24 },
];

export const WORKER_COLUMNS: SkeletonColumn[] = [
  { header: "Worker", cell: 140 },
  { header: "Status", cell: "pill" },
  { header: "Active Dispatches", cell: 24 },
];

/** The rows the Deployment panel always shows, before component health. */
export const DEPLOYMENT_KEYS = ["Mode", "Instances", "Workers", "Uptime"];

/** The rows `serveConfigRows` produces for every config, in order. */
export const SERVE_CONFIG_KEYS = [
  "Port",
  "TLS",
  "Auth Mode",
  "Scheduling",
  "Dashboard",
  "Remote Only",
  "Auto Resume",
  "Hot Reload",
  "Trust Proxy",
];

const SYS_ROW_STYLE = { padding: "8px 18px" };

function PanelHeader(
  { title, right }: { title: ReactNode; right?: ReactNode },
) {
  return (
    <div className="panel-header">
      <div className="panel-title">{title}</div>
      {right}
    </div>
  );
}

/** A titled panel holding a table skeleton (Cluster Instances, Workers). */
export function TablePanelSkeleton(
  { title, columns, rows, label }: {
    title: string;
    columns: SkeletonColumn[];
    rows: number;
    label: string;
  },
) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <PanelHeader
        title={
          <>
            {title} <CountSkeleton />
          </>
        }
      />
      <SkeletonTable columns={columns} rows={rows} label={label} />
    </div>
  );
}

/** The Deployment panel until the health stream delivers. */
export function DeploymentPanelSkeleton() {
  return (
    <div className="panel">
      <PanelHeader
        title="Deployment"
        right={<Skeleton width={76} height={20} radius={10} />}
      />
      <HealthUnavailable
        state="loading"
        subject="deployment and component health"
        skeleton={
          <SkeletonKeyValues
            keys={[...DEPLOYMENT_KEYS, "components"]}
            rowStyle={SYS_ROW_STYLE}
          />
        }
      />
    </div>
  );
}

/** A titled key/value panel (Datastore, Serve Configuration). */
export function KeyValuePanelSkeleton(
  { title, keys, rows, label }: {
    title: string;
    keys?: readonly string[];
    rows?: number;
    label: string;
  },
) {
  return (
    <div className="panel">
      <PanelHeader title={title} />
      <SkeletonRegion label={label}>
        <SkeletonKeyValues keys={keys} rows={rows} rowStyle={SYS_ROW_STYLE} />
      </SkeletonRegion>
    </div>
  );
}

// ── Data detail ────────────────────────────────────────────────────────

// Indents and widths of a pretty-printed document, so the content panel
// reads as code rather than a paragraph.
const CODE_LINES: Array<[number, string]> = [
  [0, "8%"],
  [1, "34%"],
  [1, "52%"],
  [2, "40%"],
  [2, "61%"],
  [2, "28%"],
  [1, "12%"],
  [1, "46%"],
  [1, "38%"],
  [0, "6%"],
];

/** The Details panel's rows that every data item has. */
export const DETAIL_KEYS = ["Version", "Created", "Content type", "Size"];

/** The Versions panel's list while `data.versions` loads. */
export function VersionsPanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="panel">
      <PanelHeader title="Versions" right={<CountSkeleton />} />
      <SkeletonRegion label="Loading versions">
        <ul className="version-list" aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i}>
              <Skeleton width={i === 0 ? 34 : 28} height={11} />
              {i === 0 && <Skeleton width={42} height={16} radius={4} />}
              <Skeleton
                width={128}
                height={10}
                style={{ marginLeft: "auto" }}
              />
            </li>
          ))}
        </ul>
      </SkeletonRegion>
    </div>
  );
}

/**
 * A data item or report page while it loads: the content panel, then
 * Details beside Versions. `versions` is false for a run's report, which
 * has no version list.
 */
export function DataDetailSkeleton(
  { versions = true }: { versions?: boolean },
) {
  return (
    <SkeletonRegion label="Loading data">
      <div className="panel" style={{ marginBottom: 16 }}>
        <PanelHeader
          title="Content"
          right={<Skeleton width={74} height={24} radius={5} />}
        />
        <div className="content-body">
          <div
            aria-hidden="true"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 9,
              padding: "4px 0",
            }}
          >
            {CODE_LINES.map(([indent, width], i) => (
              <Skeleton
                key={i}
                width={width}
                height={9}
                style={{ marginLeft: indent * 20 }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="panels-grid">
        <div className="panel">
          <PanelHeader title="Details" />
          <div className="detail-rows">
            <SkeletonKeyValues
              keys={DETAIL_KEYS}
              rowClassName="detail-row"
              keyClassName="detail-key"
            />
          </div>
        </div>
        {versions && <VersionsPanelSkeleton />}
      </div>
    </SkeletonRegion>
  );
}

/** The header's version badge while the item loads. */
export function VersionBadgeSkeleton() {
  return <Skeleton width={34} height={18} radius={4} />;
}

// ── Login ──────────────────────────────────────────────────────────────

/**
 * The OAuth card while serve starts the device login: shaped like the
 * confirmation-code card that follows, so only the code fills in.
 */
export function LoginStartingSkeleton() {
  return (
    <SkeletonRegion label="Starting login">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Skeleton width="92%" height={11} />
        <Skeleton width="64%" height={11} style={{ marginBottom: 20 }} />
      </div>
      <div className="login-code-block" aria-hidden="true">
        <div className="login-code-label">Confirmation code</div>
        {/* The code block is already the placeholder tone; step up a shade. */}
        <Skeleton
          width={196}
          height={34}
          radius={6}
          style={{ backgroundColor: "var(--border)" }}
        />
      </div>
      <div className="login-waiting" aria-hidden="true">
        <Skeleton width={180} height={11} />
      </div>
    </SkeletonRegion>
  );
}
