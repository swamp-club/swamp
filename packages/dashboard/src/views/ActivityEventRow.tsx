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
import { useState } from "react";
import type { AuditEvent } from "../client/useAuditStream.ts";
import { ActorWithClient } from "../components/ActorWithClient.tsx";
import { formatAbsoluteTime } from "../lib/format.ts";
import { actorLabel } from "./actor_label.ts";

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

export function EventRow({ event }: { event: AuditEvent }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `audit-${event.id}`;

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
        <ActorWithClient
          actor={actorLabel(event)}
          client={event.client}
          className="act-ellipsis act-muted"
        />
        <span className="mono act-ellipsis act-muted act-resource">
          {event.resourceKind}:{event.resourceName}
        </span>
      </button>
      {expanded && <EventDetail event={event} id={detailId} />}
    </div>
  );
}

export function EventDetail({ event, id }: { event: AuditEvent; id: string }) {
  const d = event.decision as Record<string, string> | undefined;
  return (
    <dl className="act-detail" id={id}>
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
      {event.client && <DetailField label="Client" value={event.client} />}
      {event.principalUsername && (
        <DetailField label="Username" value={event.principalUsername} />
      )}
      {event.principalEmail && (
        <DetailField label="Email" value={event.principalEmail} />
      )}
      {event.methodName && (
        <DetailField label="Method" value={event.methodName} />
      )}
      {event.detail && <DetailField label="Detail" value={event.detail} wide />}
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
  );
}
