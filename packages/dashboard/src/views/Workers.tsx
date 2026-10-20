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
import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import { useFleetData } from "../client/useFleetData.ts";
import { useTabVisible } from "../client/run_activity.ts";
import {
  clampTtlMinutes,
  formatTtl,
  TTL_DEFAULT_MINUTES,
  TTL_MAX_MINUTES,
  TTL_STEP_MINUTES,
} from "../client/fleet_refresh.ts";
import {
  assignSlots,
  type FleetLease,
  type FleetWorker,
  freeSlots,
  groupKeys,
  groupValue,
  isEligible,
  isEmptySelector,
  isUp,
  isVisible,
  parseSelector,
  type Slot,
  type SlotState,
  toSchedulable,
  type WorkerStatus,
} from "../lib/host_map_model.ts";
import { HostMap } from "../components/HostMap.tsx";
import { RouteLink } from "../components/RouteLink.tsx";
import type { RouteState } from "../routes.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { LoadError } from "../components/LoadError.tsx";
import { Skeleton, SkeletonRegion } from "../components/Skeleton.tsx";
import "../styles/host-map.css";

const GROUP_KEY = "swamp.fleet.groupBy";
const TTL_KEY = "swamp.fleet.ttlMinutes";
const TICK_MS = 2_000;

const STATUSES: readonly WorkerStatus[] = [
  "unverified",
  "idle",
  "busy",
  "draining",
  "disconnected",
];

const STATUS_LABEL: Record<WorkerStatus, string> = {
  unverified: "Unverified",
  idle: "Idle",
  busy: "Busy",
  draining: "Draining",
  disconnected: "Disconnected",
};

const SLOT_LABEL: Record<SlotState, string> = {
  free: "free",
  active: "lease active",
  completed: "completed",
  failed: "failed",
  expired: "expired",
};

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page load only.
  }
}

function groupLabel(key: string): string {
  if (key === "platform") return "Platform";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function Workers(
  { health }: { health: HealthSnapshot | null },
) {
  const [groupBy, setGroupBy] = useState(
    () => readStored(GROUP_KEY) ?? "fleet",
  );
  const [ttlMinutes, setTtlMinutes] = useState(() =>
    clampTtlMinutes(Number(readStored(TTL_KEY) ?? TTL_DEFAULT_MINUTES))
  );
  const [selectorText, setSelectorText] = useState("");
  const [shown, setShown] = useState<Record<WorkerStatus, boolean>>({
    unverified: true,
    idle: true,
    busy: true,
    draining: true,
    disconnected: true,
  });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fleet = useFleetData(health?.workers, ttlMinutes);
  const ttlMs = ttlMinutes * 60_000;
  const tabVisible = useTabVisible();

  // The clock stops while the tab is hidden and catches up on return.
  useEffect(() => {
    if (!tabVisible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [tabVisible]);

  // Slots keep their dispatch across refreshes; ended leases show briefly.
  const slotsRef = useRef(new Map<string, Slot[]>());
  const slots = useMemo(() => {
    const byDispatch = new Map<string, FleetLease>(
      fleet.leases.map((l) => [l.dispatchId, l]),
    );
    const next = new Map<string, Slot[]>();
    for (const worker of fleet.workers) {
      next.set(
        worker.name,
        assignSlots(slotsRef.current.get(worker.name), worker, byDispatch, now),
      );
    }
    return next;
  }, [fleet.workers, fleet.leases, now]);
  // Commit the slot assignment after render, so a repeated render reuses the
  // same previous state instead of advancing it twice.
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  const visible = useMemo(
    () =>
      fleet.workers.filter((w) => shown[w.status] && isVisible(w, now, ttlMs)),
    [fleet.workers, shown, now, ttlMs],
  );
  const keys = useMemo(() => groupKeys(fleet.workers), [fleet.workers]);
  const activeGroupBy = keys.includes(groupBy) ? groupBy : "fleet";
  const parsed = useMemo(() => parseSelector(selectorText), [selectorText]);
  const selecting = !isEmptySelector(parsed.selector);
  const matches = selecting
    ? fleet.workers.filter((w) => isEligible(parsed.selector, toSchedulable(w)))
    : [];
  const selected = fleet.workers.find((w) => w.name === selectedName) ?? null;

  const counts: Record<WorkerStatus, number> = {
    unverified: 0,
    idle: 0,
    busy: 0,
    draining: 0,
    disconnected: 0,
  };
  let usedSlots = 0;
  let totalSlots = 0;
  for (const worker of fleet.workers) {
    counts[worker.status]++;
    if (isUp(worker)) {
      usedSlots += worker.activeDispatchIds.length;
      totalSlots += worker.capacity;
    }
  }

  function chooseGroup(key: string) {
    setGroupBy(key);
    writeStored(GROUP_KEY, key);
  }

  function stepTtl(delta: number) {
    const next = clampTtlMinutes(ttlMinutes + delta);
    setTtlMinutes(next);
    writeStored(TTL_KEY, String(next));
  }

  return (
    <>
      <div className="page-header">
        <h1>Workers</h1>
        <div className="header-right fleet-stats" aria-live="polite">
          {STATUSES.map((s) => (
            <span key={s}>
              <strong>{counts[s]}</strong> {STATUS_LABEL[s].toLowerCase()}
            </span>
          ))}
          <span>
            <strong>{usedSlots}/{totalSlots}</strong> slots in use
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14, padding: "12px 16px" }}>
        <div className="fleet-toolbar">
          <div className="fleet-field">
            <span className="fleet-field-label" id="fleet-group-label">
              Group by
            </span>
            <div
              className="fleet-seg"
              role="group"
              aria-labelledby="fleet-group-label"
            >
              {keys.map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={key === activeGroupBy}
                  onClick={() => chooseGroup(key)}
                >
                  {groupLabel(key)}
                </button>
              ))}
            </div>
          </div>
          <div className="fleet-field">
            <label className="fleet-field-label" htmlFor="fleet-selector">
              Placement selector
            </label>
            <input
              id="fleet-selector"
              className="fleet-input"
              placeholder="gpu=h100, platform=linux"
              autoComplete="off"
              spellCheck={false}
              value={selectorText}
              onChange={(e) => setSelectorText(e.target.value)}
              aria-describedby="fleet-selector-result"
            />
          </div>
          <div className="fleet-field">
            <span className="fleet-field-label" id="fleet-status-label">
              Status
            </span>
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
              role="group"
              aria-labelledby="fleet-status-label"
            >
              {STATUSES.map((s) => (
                <button
                  type="button"
                  key={s}
                  className="fleet-chip"
                  aria-pressed={shown[s]}
                  onClick={() => setShown({ ...shown, [s]: !shown[s] })}
                >
                  <span className={`fleet-swatch hm-s-${s}`} />
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="fleet-field">
            <span className="fleet-field-label" id="fleet-ttl-label">
              Visibility TTL
            </span>
            <div
              className="fleet-ttl"
              role="group"
              aria-labelledby="fleet-ttl-label"
            >
              <button
                type="button"
                aria-label="Shorter visibility TTL"
                disabled={ttlMinutes <= TTL_STEP_MINUTES}
                onClick={() => stepTtl(-TTL_STEP_MINUTES)}
              >
                −
              </button>
              <output aria-live="polite">{formatTtl(ttlMinutes)}</output>
              <button
                type="button"
                aria-label="Longer visibility TTL"
                disabled={ttlMinutes >= TTL_MAX_MINUTES}
                onClick={() => stepTtl(TTL_STEP_MINUTES)}
              >
                +
              </button>
            </div>
          </div>
        </div>
        <div
          className="fleet-key"
          style={{ marginTop: 10 }}
          id="fleet-selector-result"
        >
          {selecting && (
            <span>
              <strong>{matches.length}</strong> workers match ·{" "}
              <strong>{freeSlots(parsed.selector, fleet.workers)}</strong>{" "}
              free slots
              {parsed.invalid.length > 0 &&
                ` · ignored: ${parsed.invalid.join(" ")}`}
            </span>
          )}
          <span>Each square is a worker, sized by its dispatch slots:</span>
          {(Object.keys(SLOT_LABEL) as SlotState[]).map((s) => (
            <span key={s}>
              <span className={`fleet-swatch hm-slot-${s}`} />
              {SLOT_LABEL[s]}
            </span>
          ))}
          <span>
            Disconnected workers fade out over the TTL.
          </span>
        </div>
      </div>

      {fleet.loading && (
        <SkeletonRegion
          label="Loading workers"
          className="panel"
          style={{ padding: 16, marginBottom: 14, display: "block" }}
        >
          <Skeleton width="100%" height={380} radius={8} />
        </SkeletonRegion>
      )}
      {!fleet.loading && fleet.error && (
        <LoadError
          subject="workers"
          message={fleet.error}
          onRetry={fleet.refetch}
        />
      )}
      {!fleet.loading && !fleet.error && fleet.workers.length === 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <EmptyState title="No remote workers">
            Steps run on this serve. Workers that join with{" "}
            <code>swamp worker connect</code> show here, grouped by fleet.
          </EmptyState>
        </div>
      )}
      {!fleet.loading && !fleet.error && fleet.workers.length > 0 && (
        <div className="fleet-layout" style={{ marginBottom: 14 }}>
          <div className="panel fleet-map" style={{ padding: 8 }}>
            <HostMap
              workers={visible}
              slots={slots}
              groupBy={activeGroupBy}
              ttlMs={ttlMs}
              selector={selecting ? parsed.selector : undefined}
              selectedName={selectedName}
              onSelect={setSelectedName}
              label={`Workers grouped by ${groupLabel(activeGroupBy)}`}
              hidden={!tabVisible}
            />
          </div>
          {selected && (
            <WorkerDetail
              worker={selected}
              slots={slots.get(selected.name) ?? []}
              groupBy={activeGroupBy}
              now={now}
              onClose={() => setSelectedName(null)}
            />
          )}
        </div>
      )}

      {fleet.workers.length > 0 && (
        <details className="panel" style={{ padding: "10px 16px" }}>
          <summary style={{ cursor: "pointer" }}>Worker table</summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Labels</th>
                  <th>Platform</th>
                  <th>Slots</th>
                </tr>
              </thead>
              <tbody>
                {fleet.workers.map((w) => (
                  <tr key={w.name}>
                    <td className="mono">{w.name}</td>
                    <td>{STATUS_LABEL[w.status]}</td>
                    <td className="mono">
                      {Object.entries(w.labels).map(([k, v]) => `${k}=${v}`)
                        .join(" ")}
                    </td>
                    <td className="mono">{w.platform}/{w.arch}</td>
                    <td className="mono">
                      {w.activeDispatchIds.length}/{w.capacity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}

function WorkerDetail(
  { worker, slots, groupBy, now, onClose }: {
    worker: FleetWorker;
    slots: readonly Slot[];
    groupBy: string;
    now: number;
    onClose: () => void;
  },
) {
  const since = worker.status === "disconnected" && worker.disconnectedAt
    ? worker.disconnectedAt
    : worker.lastSeenAt;
  const ageS = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return (
    <aside
      className="panel fleet-detail"
      style={{ padding: 16 }}
      aria-label={`Worker ${worker.name}`}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div className="mono" style={{ fontWeight: 600 }}>{worker.name}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
            enrolled via token “{worker.tokenName}” ·{" "}
            {groupValue(worker, groupBy)}
          </div>
        </div>
        <button
          type="button"
          className="btn-sm"
          aria-label="Close worker details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="fleet-detail-row">
        <span>Status</span>
        <span>{STATUS_LABEL[worker.status]}</span>
      </div>
      <div className="fleet-detail-row">
        <span>
          {worker.status === "disconnected"
            ? "Disconnected for"
            : "Last change"}
        </span>
        <span className="mono">{ageS}s ago</span>
      </div>
      <div className="fleet-detail-row">
        <span>Platform</span>
        <span className="mono">{worker.platform}/{worker.arch}</span>
      </div>
      <div className="fleet-detail-row">
        <span>Dispatch slots</span>
        <span className="mono">
          {worker.activeDispatchIds.length} of {worker.capacity} leased
        </span>
      </div>
      <div className="fleet-labels">
        {Object.entries(worker.labels).map(([k, v]) => (
          <span className="fleet-label" key={k}>{k}={v}</span>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          borderTop: "1px solid var(--border-subtle)",
          paddingTop: 8,
        }}
      >
        {slots.map((slot, i) => (
          <div className="fleet-slot-row" key={i}>
            <span className={`fleet-swatch hm-slot-${slot.state}`} />
            <span className="fleet-slot-what">
              {slot.lease
                ? (
                  <SlotLink lease={slot.lease}>
                    {`${slot.lease.workflowName ?? "—"} › ${
                      slot.lease.stepName ?? "—"
                    } · ${slot.lease.methodName}`}
                  </SlotLink>
                )
                : slot.state === "active"
                ? `dispatch ${slot.dispatchId?.slice(0, 8) ?? ""}`
                : `slot ${i + 1} · free`}
            </span>
            <span className="fleet-slot-when">
              {slot.state === "active" && slot.lease
                ? `${
                  Math.max(
                    0,
                    Math.round((now - Date.parse(slot.lease.createdAt)) / 1000),
                  )
                }s`
                : slot.state === "free"
                ? ""
                : SLOT_LABEL[slot.state]}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Links a slot's lease to the run it serves, or to its workflow when the run is not known. */
function SlotLink(
  { lease, children }: { lease: FleetLease; children: string },
) {
  if (!lease.workflowName) return <>{children}</>;
  const to: RouteState = lease.workflowRunId
    ? {
      view: "workflows",
      detail: {
        kind: "run",
        workflowName: lease.workflowName,
        runId: lease.workflowRunId,
      },
    }
    : {
      view: "workflows",
      detail: { kind: "workflow", workflowName: lease.workflowName },
    };
  return (
    <RouteLink
      to={to}
      className="fleet-slot-link"
      title={lease.workflowRunId
        ? `Open run ${lease.workflowRunId.slice(0, 8)} of ${lease.workflowName}`
        : `Open workflow ${lease.workflowName}`}
    >
      {children}
    </RouteLink>
  );
}
