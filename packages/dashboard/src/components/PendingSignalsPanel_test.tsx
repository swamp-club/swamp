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
import { PendingSignalsPanel } from "./PendingSignalsPanel.tsx";
import type { PendingSignalRow } from "../client/signal_wait_state.ts";

const HOUR = 60 * 60 * 1000;

function rowHeldFor(ms: number, receiptId: string): PendingSignalRow {
  return {
    workflowId: "wf-1",
    workflowName: "deploy",
    key: "order-42",
    receiptId,
    receivedAt: "2026-10-08T12:00:00.000Z",
    heldUntil: new Date(Date.now() + ms).toISOString(),
    submittedBy: "user:ada",
  };
}

Deno.test("PendingSignalsPanel: renders nothing when no signal is held", () => {
  assertEquals(renderToStaticMarkup(<PendingSignalsPanel rows={[]} />), "");
});

Deno.test("PendingSignalsPanel: a held signal shows its key, workflow, receipt, receipt time and time left", () => {
  const now = Date.parse("2026-10-08T12:30:00.000Z");
  const row = {
    ...rowHeldFor(0, "sig-1"),
    heldUntil: new Date(now + 2 * HOUR + 30_000).toISOString(),
  };
  const html = renderToStaticMarkup(
    <PendingSignalsPanel rows={[row]} now={now} />,
  );
  assertStringIncludes(html, "Pending signals");
  assertStringIncludes(html, '<span class="panel-count">1</span>');
  assertStringIncludes(html, "deploy");
  assertStringIncludes(html, "key order-42");
  assertStringIncludes(html, 'data-pending-signal="sig-1"');
  assertStringIncludes(html, "user:ada");
  assertStringIncludes(html, "2026-10-08T12:00:00.000Z");
  assertStringIncludes(html, `Held until`);
  assertStringIncludes(html, row.heldUntil);
  assertStringIncludes(html, "2h 00m left");
});

Deno.test("PendingSignalsPanel: judges the rows by the page's clock when given one", () => {
  const held = {
    ...rowHeldFor(0, "sig-held"),
    heldUntil: "2026-10-08T13:00:00.000Z",
  };
  const at = (iso: string) =>
    renderToStaticMarkup(
      <PendingSignalsPanel rows={[held]} now={Date.parse(iso)} />,
    );
  // Held until the instant itself, as serve judges it; gone after it.
  assertStringIncludes(at("2026-10-08T13:00:00.000Z"), "sig-held");
  assertEquals(at("2026-10-08T13:00:00.001Z"), "");
});

Deno.test("PendingSignalsPanel: hides a signal past its hold", () => {
  const html = renderToStaticMarkup(
    <PendingSignalsPanel
      rows={[rowHeldFor(-HOUR, "lapsed"), rowHeldFor(HOUR, "live")]}
    />,
  );
  assertStringIncludes(html, 'data-pending-signal="live"');
  assertEquals(html.includes("lapsed"), false);
  assertStringIncludes(html, '<span class="panel-count">1</span>');
});

Deno.test("PendingSignalsPanel: renders nothing when every signal is past its hold", () => {
  assertEquals(
    renderToStaticMarkup(
      <PendingSignalsPanel rows={[rowHeldFor(-1000, "lapsed")]} />,
    ),
    "",
  );
});

Deno.test("PendingSignalsPanel: escapes markup in the key and sender", () => {
  const html = renderToStaticMarkup(
    <PendingSignalsPanel
      rows={[{
        ...rowHeldFor(HOUR, "sig-1"),
        key: "<script>alert(1)</script>",
        submittedBy: "<b>x</b>",
      }]}
    />,
  );
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("<b>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});
