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
import { BEHAVIOR_COLUMN } from "../lib/behavior_labels.ts";

// each skeleton mirrors the loaded layout so nothing moves when the answer
// lands; views share these column lists so skeleton and table never drift

const CHART_LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["Succeeded", "var(--chart-bar-1)"],
  ["Failed", "var(--chart-bar-2)"],
  ["Cancelled", "var(--chart-bar-5)"],
  ["Running / waiting", "var(--chart-bar-4)"],
];

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

export function ExecutionChartSkeleton() {
  return (
    <ExecutionChartFrame>
      <SkeletonRegion label="Loading executions chart" className="chart-area">
        <SkeletonChart bars={7} height="100%" />
      </SkeletonRegion>
    </ExecutionChartFrame>
  );
}

export function StatValueSkeleton({ width = 80 }: { width?: number }) {
  return <Skeleton width={width} height={26} radius={6} />;
}

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

export function UpcomingSchedulesSkeleton() {
  return (
    <HealthUnavailable
      state="loading"
      subject="schedules"
      skeleton={<ScheduleRowsSkeleton />}
    />
  );
}

export function CountSkeleton() {
  return <Skeleton width={22} height={14} radius={10} />;
}

export const DATA_COLUMNS: SkeletonColumn[] = [
  { header: "Name" },
  { header: BEHAVIOR_COLUMN, cell: 110 },
  { header: "Type", cell: 56 },
  { header: "Content Type", cell: 120 },
  { header: "Version", cell: 32 },
];

export function DataTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <SkeletonTable columns={DATA_COLUMNS} rows={rows} label="Loading data" />
  );
}

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

export function VaultSectionSkeleton(
  { label, rows = 3, badge = false }: {
    label: string;
    rows?: number;
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

export const CLUSTER_COLUMNS: SkeletonColumn[] = [
  { header: "Instance", cell: 120 },
  { header: "Status", cell: "pill" },
  { header: "Uptime", cell: "mono" },
  { header: "Active Runs", cell: 24 },
  { header: "Throughput", cell: "mono" },
  { header: "P95 Latency", cell: 40 },
  { header: "Workers", cell: 24 },
];

export const WORKER_SUMMARY_KEYS = [
  "Idle",
  "Busy",
  "Unverified",
  "Draining",
  "Slots in use",
] as const;

export const DEPLOYMENT_KEYS = ["Mode", "Instances", "Workers", "Uptime"];

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

export const DETAIL_KEYS = ["Version", "Created", "Content type", "Size"];

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

/** versions is false for a run's report, which has no version list */
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

export function VersionBadgeSkeleton() {
  return <Skeleton width={34} height={18} radius={4} />;
}

/**
 * shaped like the confirmation-code card that follows, so only the code fills
 * in
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
