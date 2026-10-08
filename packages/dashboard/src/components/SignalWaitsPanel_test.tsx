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
import { SignalWaitsPanel } from "./SignalWaitsPanel.tsx";
import type { SignalWaitRow } from "../client/signal_wait_state.ts";

const base = {
  waitId: "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90",
  workflowName: "deploy",
  runId: "0d6a1f6e-1111-4222-8333-444455556666",
  stepName: "await-verdict",
  deadline: "2026-10-09T00:00:00.000Z",
  awaitingResume: false,
};

const open: SignalWaitRow = {
  ...base,
  state: "open",
  schema: { properties: { verdict: { type: "string" } } },
  command: `swamp workflow signal ${base.waitId} --payload '<json>'`,
};

const signalled: SignalWaitRow = {
  ...base,
  state: "signalled",
  receipt: {
    id: "sig-1",
    submittedBy: "user:ada",
    receivedAt: "2026-10-08T12:00:00.000Z",
  },
  command: `swamp workflow resume deploy --run ${base.runId}`,
};

const expired: SignalWaitRow = {
  ...base,
  state: "expired",
  command: `swamp workflow resume deploy --run ${base.runId}`,
};

Deno.test("SignalWaitsPanel: renders nothing when no run waits", () => {
  assertEquals(renderToStaticMarkup(<SignalWaitsPanel rows={[]} />), "");
});

Deno.test("SignalWaitsPanel: an open wait shows its ID, deadline, schema and the signal command", () => {
  const html = renderToStaticMarkup(<SignalWaitsPanel rows={[open]} />);
  assertStringIncludes(html, 'data-wait-state="open"');
  assertStringIncludes(html, base.waitId);
  assertStringIncludes(html, base.deadline);
  assertStringIncludes(html, "await-verdict");
  assertStringIncludes(html, "verdict");
  assertStringIncludes(html, "swamp workflow signal");
  assertEquals(html.includes("swamp workflow resume"), false);
});

Deno.test("SignalWaitsPanel: a signalled wait shows its receipt and the resume command", () => {
  const html = renderToStaticMarkup(<SignalWaitsPanel rows={[signalled]} />);
  assertStringIncludes(html, 'data-wait-state="signalled"');
  assertStringIncludes(html, "sig-1");
  assertStringIncludes(html, "user:ada");
  assertStringIncludes(html, "2026-10-08T12:00:00.000Z");
  assertStringIncludes(html, "swamp workflow resume deploy");
  assertEquals(html.includes("swamp workflow signal"), false);
});

Deno.test("SignalWaitsPanel: the resume control replaces the command only for a run that can resume", () => {
  const renderResume = (row: SignalWaitRow) => (
    <button type="button">resume {row.runId}</button>
  );
  const held = renderToStaticMarkup(
    <SignalWaitsPanel rows={[signalled]} renderResume={renderResume} />,
  );
  assertEquals(held.includes("<button"), false);
  assertStringIncludes(held, "swamp workflow resume deploy");

  const ready = renderToStaticMarkup(
    <SignalWaitsPanel
      rows={[{ ...signalled, awaitingResume: true }]}
      renderResume={renderResume}
    />,
  );
  assertStringIncludes(ready, `resume ${base.runId}</button>`);
  assertEquals(ready.includes("swamp workflow resume deploy"), false);
});

Deno.test("SignalWaitsPanel: the resume control is never offered for an open or expired wait", () => {
  const html = renderToStaticMarkup(
    <SignalWaitsPanel
      rows={[
        { ...open, awaitingResume: true },
        { ...expired, waitId: "other", awaitingResume: true },
      ]}
      renderResume={() => <button type="button">resume</button>}
    />,
  );
  assertEquals(html.includes("<button"), false);
});

Deno.test("SignalWaitsPanel: an expired wait shows the resume command and no signal command", () => {
  const html = renderToStaticMarkup(<SignalWaitsPanel rows={[expired]} />);
  assertStringIncludes(html, 'data-wait-state="expired"');
  assertStringIncludes(html, "Deadline passed");
  assertStringIncludes(html, "swamp workflow resume deploy");
  assertEquals(html.includes("swamp workflow signal"), false);
});

Deno.test("SignalWaitsPanel: counts every row in the header", () => {
  const html = renderToStaticMarkup(
    <SignalWaitsPanel
      rows={[open, { ...signalled, waitId: "b" }, { ...expired, waitId: "c" }]}
    />,
  );
  assertStringIncludes(html, '<span class="panel-count">3</span>');
});

Deno.test("SignalWaitsPanel: escapes markup in workflow and step names", () => {
  const html = renderToStaticMarkup(
    <SignalWaitsPanel
      rows={[{
        ...open,
        workflowName: "<script>alert(1)</script>",
        stepName: '<img src=x onerror="y">',
      }]}
    />,
  );
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("<img"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});
