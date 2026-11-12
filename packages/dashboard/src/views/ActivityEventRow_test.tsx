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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditEvent } from "../client/useAuditStream.ts";
import { EventDetail, EventRow } from "./ActivityEventRow.tsx";

function event(extra: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    timestamp: "2026-11-12T15:00:00.000Z",
    instanceId: "serve-1",
    category: "execution",
    stage: "response",
    outcome: "success",
    action: "workflow.approve",
    resourceKind: "workflow",
    resourceName: "deploy",
    principalKind: "user",
    principalId: "sub-1",
    initiatedBy: "user:sub-1",
    principalUsername: "alice",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    ...extra,
  };
}

Deno.test("EventRow: names an integration client after the actor", () => {
  const html = renderToStaticMarkup(
    <EventRow event={event({ client: "integration:slackwater" })} />,
  );
  assertStringIncludes(
    html,
    '<span class="act-ellipsis act-muted" title="alice via integration:slackwater">alice<span class="client-via"> via integration:slackwater</span></span>',
  );
});

Deno.test("EventRow: a direct client shows the actor alone", () => {
  const html = renderToStaticMarkup(
    <EventRow event={event({ client: "direct:dashboard" })} />,
  );
  assertStringIncludes(
    html,
    '<span class="act-ellipsis act-muted" title="alice">alice</span>',
  );
  assertEquals(html.includes(" via "), false);
});

Deno.test("EventRow: an event with no client shows the actor as before", () => {
  const html = renderToStaticMarkup(<EventRow event={event()} />);
  assertStringIncludes(
    html,
    '<span class="act-ellipsis act-muted" title="alice">alice</span>',
  );
  assertEquals(html.includes(" via "), false);
});

Deno.test("EventDetail: shows any recorded client, direct ones included", () => {
  for (const client of ["integration:slackwater", "direct:dashboard"]) {
    const html = renderToStaticMarkup(
      <EventDetail event={event({ client })} id="d" />,
    );
    assertStringIncludes(html, `<dt>Client</dt><dd>${client}</dd>`);
  }
});

Deno.test("EventDetail: an event with no client has no Client field", () => {
  const html = renderToStaticMarkup(<EventDetail event={event()} id="d" />);
  assert(!html.includes("<dt>Client</dt>"));
  assertStringIncludes(html, "<dt>Principal ID</dt><dd>sub-1</dd>");
});
