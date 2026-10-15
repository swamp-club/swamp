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

import { useMemo, useState } from "react";
import type { AuditEvent, AuditStream } from "../client/useAuditStream.ts";
import { copyText } from "../components/clipboard.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { formatAbsoluteTime, formatCount, pluralize } from "../lib/format.ts";
import { actorLabel } from "./actor_label.ts";
import {
  AUDIT_COLUMNS,
  AuditDeniedState,
  AuditDisabledState,
  AuditErrorState,
  AuditFeedSkeleton,
  auditFeedView,
  AuditLiveToggle,
} from "./AuditStates.tsx";
import "../styles/activity.css";

// Category hues come from the theme's status tokens so both themes read.
const CATEGORY_TONE: Record<string, string> = {
  auth: "info",
  access: "warning",
  execution: "success",
  secrets: "danger",
  admin: "running",
  data: "info",
  system: "cancelled",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function CategoryBadge({ category }: { category: string }) {
  const tone = CATEGORY_TONE[category] ?? "cancelled";
  return <span className={`act-cat act-tone-${tone}`}>{category}</span>;
}

function OutcomeDot({ outcome }: { outcome: string }) {
  return (
    <span
      className={`act-outcome act-outcome-${outcome}`}
      title={outcome}
      role="img"
      aria-label={`Outcome: ${outcome}`}
    />
  );
}

function DetailField(
  { label, value, wide }: { label: string; value: string; wide?: boolean },
) {
  return (
    <div className={wide ? "act-field act-field-wide" : "act-field"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function EventRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `audit-${event.id}`;
  const d = event.decision as Record<string, string> | undefined;

  return (
    <div className={`act-event${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="act-row act-row-grid"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className="mono act-time"
          title={formatAbsoluteTime(event.timestamp)}
        >
          {formatTime(event.timestamp)}
        </span>
        <OutcomeDot outcome={event.outcome} />
        <CategoryBadge category={event.category} />
        <span className="mono act-ellipsis">{event.action}</span>
        <span className="act-ellipsis act-muted">{actorLabel(event)}</span>
        <span className="mono act-ellipsis act-muted act-resource">
          {event.resourceKind}:{event.resourceName}
        </span>
      </button>
      {expanded && (
        <dl className="act-detail" id={detailId}>
          <DetailField label="ID" value={event.id} />
          <DetailField label="Request" value={event.requestId} />
          <DetailField
            label="Time"
            value={formatAbsoluteTime(event.timestamp)}
          />
          <DetailField label="Instance" value={event.instanceId} />
          <DetailField label="Source IP" value={event.sourceIp} />
          <DetailField label="Initiated by" value={event.initiatedBy} />
          <DetailField label="Principal kind" value={event.principalKind} />
          <DetailField label="Principal ID" value={event.principalId} />
          {event.principalUsername && (
            <DetailField label="Username" value={event.principalUsername} />
          )}
          {event.principalEmail && (
            <DetailField label="Email" value={event.principalEmail} />
          )}
          {event.methodName && (
            <DetailField label="Method" value={event.methodName} />
          )}
          {event.detail && (
            <DetailField label="Detail" value={event.detail} wide />
          )}
          {d && (
            <div
              className={`act-decision act-decision-${
                d.effect === "deny" ? "deny" : "allow"
              }`}
            >
              <strong>Decision</strong> {d.effect} {d.action} on{" "}
              {d.resourceKind}:{d.resourceName}
              {d.grantId && (
                <span className="act-muted">{` (grant ${d.grantId})`}</span>
              )}
            </div>
          )}
        </dl>
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
const EVENT_LIMITS = [100, 500, 1000];

function ToggleGroup(
  { label, options, selected, onToggle }: {
    label: string;
    options: string[];
    selected: Set<string>;
    onToggle: (value: string) => void;
  },
) {
  return (
    <div className="time-range" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o}
          className={selected.has(o) ? "active" : ""}
          aria-pressed={selected.has(o)}
          onClick={() => onToggle(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function toggleIn(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function Activity({ auditStream }: { auditStream: AuditStream }) {
  const {
    events,
    status,
    historyLoaded,
    liveEnabled,
    error,
    clearEvents,
    setLiveEnabled,
    reconnect,
    maxEvents,
    setMaxEvents,
  } = auditStream;
  const [categoryFilters, setCategoryFilters] = useState<Set<string>>(
    () => new Set(),
  );
  const [outcomeFilters, setOutcomeFilters] = useState<Set<string>>(
    () => new Set(),
  );

  const newestFirst = useMemo(() => {
    const filtered = events.filter((e) =>
      (categoryFilters.size === 0 || categoryFilters.has(e.category)) &&
      (outcomeFilters.size === 0 || outcomeFilters.has(e.outcome))
    );
    return filtered.reverse();
  }, [events, categoryFilters, outcomeFilters]);

  const filtering = categoryFilters.size > 0 || outcomeFilters.size > 0;
  const clearFilters = () => {
    setCategoryFilters(new Set());
    setOutcomeFilters(new Set());
  };

  if (status === "disabled" || status === "denied") {
    return (
      <>
        <div className="page-header">
          <h1>Activity</h1>
        </div>
        {status === "disabled"
          ? <AuditDisabledState copy={copyText} />
          : <AuditDeniedState message={error} />}
      </>
    );
  }

  const feedView = auditFeedView(status, events.length, historyLoaded);
  const loading = feedView === "loading";

  return (
    <>
      <div className="page-header">
        <h1>Activity</h1>
        <div className="header-right">
          {feedView === "feed" && (
            <span className="mono act-count" aria-live="polite">
              {filtering
                ? `${formatCount(newestFirst.length)} of ${
                  pluralize(events.length, "event")
                }`
                : pluralize(events.length, "event")}
            </span>
          )}
          <AuditLiveToggle
            status={status}
            onToggle={() =>
              status === "error" ? reconnect() : setLiveEnabled(!liveEnabled)}
          />
        </div>
      </div>

      <div className="act-toolbar">
        <ToggleGroup
          label="Filter by category"
          options={CATEGORIES}
          selected={categoryFilters}
          onToggle={(c) => setCategoryFilters((prev) => toggleIn(prev, c))}
        />
        <ToggleGroup
          label="Filter by outcome"
          options={OUTCOMES}
          selected={outcomeFilters}
          onToggle={(o) => setOutcomeFilters((prev) => toggleIn(prev, o))}
        />
        <span className="act-toolbar-spacer" />
        <div className="time-range" role="group" aria-label="Events to keep">
          {EVENT_LIMITS.map((n) => (
            <button
              type="button"
              key={n}
              className={maxEvents === n ? "active" : ""}
              aria-pressed={maxEvents === n}
              onClick={() => setMaxEvents(n)}
            >
              {formatCount(n)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-sm"
          onClick={clearEvents}
          disabled={events.length === 0}
        >
          Clear
        </button>
      </div>

      {status === "error" && (
        <AuditErrorState message={error} onRetry={reconnect} />
      )}

      {feedView === "error"
        ? null
        : loading
        ? <AuditFeedSkeleton />
        : (
          <div className="act-feed">
            <div className="act-row-grid act-feed-head" aria-hidden="true">
              {AUDIT_COLUMNS.map((c, i) => <span key={i}>{c}</span>)}
            </div>
            {newestFirst.length === 0
              ? filtering
                ? (
                  <EmptyState
                    title="No events match these filters"
                    action={
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={clearFilters}
                      >
                        Clear filters
                      </button>
                    }
                  />
                )
                : (
                  <EmptyState title="No activity yet">
                    {status === "live"
                      ? "Events appear here as soon as anyone uses this server."
                      : "Resume the live feed to see new events."}
                  </EmptyState>
                )
              : (
                <div className="act-feed-body">
                  {newestFirst.map((event, idx) => (
                    <EventRow key={`${event.id}-${idx}`} event={event} />
                  ))}
                </div>
              )}
          </div>
        )}
    </>
  );
}
