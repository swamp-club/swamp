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
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUDIT_CONFIG_SNIPPET,
  AUDIT_MANUAL_LINKS,
  AuditDeniedState,
  AuditDisabledState,
  AuditErrorState,
  AuditFeedSkeleton,
  auditFeedView,
  AuditLiveToggle,
} from "./AuditStates.tsx";

Deno.test("AuditDisabledState: explains the log, shows the config to copy and links the manual", () => {
  const html = renderToStaticMarkup(
    <AuditDisabledState copy={() => Promise.resolve(true)} />,
  );
  assertStringIncludes(html, 'data-audit-state="disabled"');
  assertStringIncludes(html, "Who ran, approved or changed what");
  assertStringIncludes(html, "A live activity feed");
  assertStringIncludes(html, ".swamp/serve.yaml");
  assertStringIncludes(html, "target: security-audit");
  assertStringIncludes(html, "Copy serve.yaml snippet");
  assertStringIncludes(html, "swamp serve check-config");
  for (const link of AUDIT_MANUAL_LINKS) {
    assertStringIncludes(html, `href="${link.href}"`);
  }
  assertStringIncludes(html, 'rel="noopener noreferrer"');
  // Never pretends a feed is coming.
  assertEquals(html.includes("Connecting"), false);
  assertEquals(html.includes("Live"), false);
});

Deno.test("AUDIT_CONFIG_SNIPPET: is the minimal audit block serve accepts", () => {
  assertStringIncludes(
    AUDIT_CONFIG_SNIPPET,
    "audit:\n  stores:\n    - target:",
  );
  // type and config must come together; both stay commented out.
  assertStringIncludes(AUDIT_CONFIG_SNIPPET, "# type:");
  assertStringIncludes(AUDIT_CONFIG_SNIPPET, "# config:");
});

Deno.test("AuditDeniedState: names the permission needed", () => {
  const html = renderToStaticMarkup(
    <AuditDeniedState message="Access denied: admin on access:audit" />,
  );
  assertStringIncludes(html, 'data-audit-state="denied"');
  assertStringIncludes(html, "access:audit");
  assertStringIncludes(html, "Access denied: admin on access:audit");
});

Deno.test("AuditErrorState: offers a reconnect", () => {
  const html = renderToStaticMarkup(
    <AuditErrorState
      message="WebSocket connection failed"
      onRetry={() => {}}
    />,
  );
  assertStringIncludes(html, 'role="alert"');
  assertStringIncludes(html, "WebSocket connection failed");
  assertStringIncludes(html, "Reconnect");
});

Deno.test("AuditFeedSkeleton: is a labelled loading region with the feed's columns", () => {
  const html = renderToStaticMarkup(<AuditFeedSkeleton rows={3} />);
  assertStringIncludes(html, 'aria-busy="true"');
  assertStringIncludes(html, "Loading activity");
  assertStringIncludes(html, "Initiated by");
  assertEquals(html.split("act-skel-row").length - 1, 3);
});

Deno.test("AuditLiveToggle: hidden without a feed, labelled per state otherwise", () => {
  const noop = () => {};
  assertEquals(
    renderToStaticMarkup(<AuditLiveToggle status="disabled" onToggle={noop} />),
    "",
  );
  assertEquals(
    renderToStaticMarkup(<AuditLiveToggle status="denied" onToggle={noop} />),
    "",
  );
  const live = renderToStaticMarkup(
    <AuditLiveToggle status="live" onToggle={noop} />,
  );
  assertStringIncludes(live, ">Live<");
  assertStringIncludes(live, 'aria-pressed="true"');
  const paused = renderToStaticMarkup(
    <AuditLiveToggle status="paused" onToggle={noop} />,
  );
  assertStringIncludes(paused, "Resume the live feed");
  assertStringIncludes(paused, 'aria-pressed="false"');
  assertStringIncludes(
    renderToStaticMarkup(
      <AuditLiveToggle status="connecting" onToggle={noop} />,
    ),
    "Connecting",
  );
});

Deno.test("auditFeedView: a failed stream with nothing loaded shows only the error", () => {
  assertEquals(auditFeedView("error", 0, false), "error");
  assertEquals(auditFeedView("error", 0, true), "error");
  assertEquals(auditFeedView("error", 3, true), "feed");
  assertEquals(auditFeedView("connecting", 0, true), "loading");
  assertEquals(auditFeedView("live", 0, false), "loading");
  assertEquals(auditFeedView("live", 0, true), "feed");
});
