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

import { useState } from "react";
import type { AuditEvent } from "../client/useAuditStream";

const CATEGORY_COLORS: Record<string, string> = {
  auth: "#6366f1",
  access: "#f59e0b",
  execution: "#22c55e",
  secrets: "#ef4444",
  admin: "#8b5cf6",
  data: "#3b82f6",
  system: "#64748b",
};

const OUTCOME_COLORS: Record<string, string> = {
  success: "var(--success)",
  failure: "var(--danger)",
  denied: "var(--warning)",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function CategoryBadge({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? "var(--text-3)";
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "0.65rem",
        fontWeight: 500,
        padding: "1px 6px",
        borderRadius: 4,
        background: `${color}20`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {category}
    </span>
  );
}

function OutcomeDot({ outcome }: { outcome: string }) {
  const color = OUTCOME_COLORS[outcome] ?? "var(--text-3)";
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        flexShrink: 0,
      }}
      title={outcome}
    />
  );
}

function EventRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "72px 18px 68px minmax(100px, 1.5fr) minmax(80px, 1fr) minmax(80px, 1fr)",
          gap: 12,
          alignItems: "center",
          padding: "8px 16px",
          fontSize: "0.8rem",
        }}
      >
        <span
          className="mono"
          style={{ color: "var(--text-3)", fontSize: "0.72rem" }}
        >
          {formatTime(event.timestamp)}
        </span>
        <OutcomeDot outcome={event.outcome} />
        <CategoryBadge category={event.category} />
        <span
          className="mono"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {event.action}
        </span>
        <span
          style={{
            color: "var(--text-3)",
            fontSize: "0.72rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {event.initiatedBy}
        </span>
        <span
          className="mono"
          style={{
            color: "var(--text-3)",
            fontSize: "0.68rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {event.resourceKind}:{event.resourceName}
        </span>
      </div>
      {expanded && (
        <div
          style={{
            padding: "8px 16px 12px",
            background: "var(--card-bg)",
            fontSize: "0.72rem",
            fontFamily: "'JetBrains Mono', monospace",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "4px 24px",
            color: "var(--text-2)",
          }}
        >
          <div>
            <strong>ID:</strong> {event.id}
          </div>
          <div>
            <strong>Request:</strong> {event.requestId}
          </div>
          <div>
            <strong>Instance:</strong> {event.instanceId}
          </div>
          <div>
            <strong>Source IP:</strong> {event.sourceIp}
          </div>
          <div>
            <strong>Initiated by:</strong> {event.initiatedBy}
          </div>
          <div>
            <strong>Principal kind:</strong> {event.principalKind}
          </div>
          {event.methodName && (
            <div>
              <strong>Method name:</strong> {event.methodName}
            </div>
          )}
          {event.detail && (
            <div style={{ gridColumn: "1 / -1" }}>
              <strong>Detail:</strong> {event.detail}
            </div>
          )}
          {event.decision && (() => {
            const d = event.decision as Record<string, string>;
            return (
              <div
                style={{
                  gridColumn: "1 / -1",
                  marginTop: 4,
                  padding: "6px 8px",
                  borderRadius: 4,
                  background: d.effect === "deny"
                    ? "rgba(239, 68, 68, 0.1)"
                    : "rgba(34, 197, 94, 0.1)",
                }}
              >
                <strong>Decision:</strong> {d.effect} {d.action} on{" "}
                {d.resourceKind}:{d.resourceName}
                {d.grantId && (
                  <span style={{ opacity: 0.7 }}>
                    {` (grant: ${d.grantId})`}
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

const CATEGORIES = [
  "auth",
  "access",
  "execution",
  "secrets",
  "admin",
  "data",
  "system",
];
const OUTCOMES = ["success", "failure", "denied"];

interface ActivityProps {
  auditStream: {
    events: AuditEvent[];
    streaming: boolean;
    liveEnabled: boolean;
    error: string | null;
    clearEvents: () => void;
    setLiveEnabled: (enabled: boolean) => void;
    maxEvents: number;
    setMaxEvents: (n: number) => void;
  };
}

const EVENT_LIMITS = [100, 500, 1000];

export function Activity({ auditStream }: ActivityProps) {
  const {
    events,
    streaming,
    liveEnabled,
    error,
    clearEvents,
    setLiveEnabled,
    maxEvents,
    setMaxEvents,
  } = auditStream;
  const [categoryFilters, setCategoryFilters] = useState<Set<string>>(
    new Set(),
  );
  const [outcomeFilters, setOutcomeFilters] = useState<Set<string>>(
    new Set(),
  );

  const toggleCategory = (c: string) => {
    setCategoryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const toggleOutcome = (o: string) => {
    setOutcomeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o);
      else next.add(o);
      return next;
    });
  };

  const filtered = events.filter((e) => {
    if (categoryFilters.size > 0 && !categoryFilters.has(e.category)) {
      return false;
    }
    if (outcomeFilters.size > 0 && !outcomeFilters.has(e.outcome)) return false;
    return true;
  });

  const reversed = [...filtered].reverse();

  return (
    <>
      <div className="page-header">
        <h1>Activity</h1>
        <div className="header-right">
          <button
            type="button"
            onClick={() => setLiveEnabled(!liveEnabled)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 5,
              fontSize: "0.78rem",
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: "pointer",
              border: streaming
                ? "1px solid var(--success)"
                : liveEnabled
                ? "1px solid var(--warning)"
                : "1px solid var(--text-3)",
              background: streaming
                ? "rgba(34, 197, 94, 0.15)"
                : liveEnabled
                ? "rgba(245, 158, 11, 0.1)"
                : "transparent",
              color: streaming
                ? "var(--success)"
                : liveEnabled
                ? "var(--warning)"
                : "var(--text-3)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: streaming
                  ? "var(--success)"
                  : liveEnabled
                  ? "var(--warning)"
                  : "var(--text-3)",
                animation: streaming ? "pulse 2s infinite" : "none",
              }}
            />
            {streaming ? "Live" : liveEnabled ? "Connecting" : "Paused"}
          </button>
          <div className="time-range">
            {EVENT_LIMITS.map((n) => (
              <button
                type="button"
                key={n}
                className={`time-btn${maxEvents === n ? " active" : ""}`}
                onClick={() => setMaxEvents(n)}
              >
                {n}
              </button>
            ))}
          </div>
          {error && (
            <span style={{ fontSize: "0.72rem", color: "var(--danger)" }}>
              {error}
            </span>
          )}
          <span
            className="mono"
            style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
          >
            {filtered.length} events
          </span>
          <div className="time-range">
            {CATEGORIES.map((c) => (
              <button
                type="button"
                key={c}
                className={`time-btn${categoryFilters.has(c) ? " active" : ""}`}
                onClick={() => toggleCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="time-range">
            {OUTCOMES.map((o) => (
              <button
                type="button"
                key={o}
                className={`time-btn${outcomeFilters.has(o) ? " active" : ""}`}
                onClick={() => toggleOutcome(o)}
              >
                {o}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="time-btn"
            onClick={clearEvents}
            style={{ marginLeft: 8 }}
          >
            Clear
          </button>
        </div>
      </div>

      <div
        className="card"
        style={{ overflow: "hidden", padding: 0, flex: 1 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "72px 18px 68px minmax(100px, 1.5fr) minmax(80px, 1fr) minmax(80px, 1fr)",
            gap: 12,
            padding: "10px 16px",
            fontSize: "0.68rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-3)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span>Time</span>
          <span></span>
          <span>Category</span>
          <span>Action</span>
          <span>Initiated By</span>
          <span>Resource</span>
        </div>
        <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 200px)" }}>
          {reversed.length === 0
            ? (
              <div
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: "var(--text-3)",
                  fontSize: "0.85rem",
                }}
              >
                {streaming
                  ? "Waiting for audit events..."
                  : "No audit events — is audit enabled in serve.yaml?"}
              </div>
            )
            : reversed.map((event, idx) => (
              <EventRow key={`${event.id}-${idx}`} event={event} />
            ))}
        </div>
      </div>

      <style>
        {`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}
      </style>
    </>
  );
}
