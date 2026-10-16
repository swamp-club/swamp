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
import { StepSignalWait } from "./StepSignalWait.tsx";

const wait = {
  id: "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90",
  deadline: "2026-10-09T00:00:00.000Z",
};
const receipt = {
  id: "sig-1",
  receivedAt: "2026-10-08T12:00:00.000Z",
  submittedBy: "user:ada",
};

Deno.test("StepSignalWait: renders nothing for a step with no wait", () => {
  assertEquals(renderToStaticMarkup(<StepSignalWait status="succeeded" />), "");
});

Deno.test("StepSignalWait: an open wait shows its ID and deadline", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="waiting" wait={wait} />,
  );
  assertStringIncludes(html, "Waiting for signal");
  assertStringIncludes(html, wait.id);
  assertStringIncludes(html, wait.deadline);
});

Deno.test("StepSignalWait: a step signalled before its resume shows the receipt and says a resume applies it", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="waiting" wait={{ ...wait, receipt }} />,
  );
  assertStringIncludes(html, "sig-1");
  assertStringIncludes(html, "user:ada");
  assertStringIncludes(html, receipt.receivedAt);
  assertStringIncludes(html, "a resume applies it");
  assertEquals(html.includes("Waiting for signal"), false);
});

Deno.test("StepSignalWait: a settled step shows the receipt without the resume note", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="succeeded" wait={{ ...wait, receipt }} />,
  );
  assertStringIncludes(html, "sig-1");
  assertEquals(html.includes("a resume applies it"), false);
});

Deno.test("StepSignalWait: a step that stopped waiting without a signal says it waited", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="failed" wait={wait} />,
  );
  assertStringIncludes(html, "Waited for signal");
});

Deno.test("StepSignalWait: escapes markup in the sender", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait
      status="waiting"
      wait={{ ...wait, receipt: { ...receipt, submittedBy: "<b>x</b>" } }}
    />,
  );
  assertEquals(html.includes("<b>"), false);
  assertStringIncludes(html, "&lt;b&gt;");
});

Deno.test("StepSignalWait: a waiting keyed step shows its key", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="waiting" wait={{ ...wait, key: "order-42" }} />,
  );
  assertStringIncludes(html, "Waiting for signal");
  assertStringIncludes(html, '(key <span class="mono">order-42</span>)');
});

Deno.test("StepSignalWait: a step without a key shows no key", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="waiting" wait={wait} />,
  );
  assertEquals(html.includes("(key"), false);
});

Deno.test("StepSignalWait: a receipt held as a pending signal says so", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait
      status="succeeded"
      wait={{
        ...wait,
        key: "order-42",
        receipt: { ...receipt, heldAsPending: true },
      }}
    />,
  );
  assertStringIncludes(html, "sig-1");
  assertStringIncludes(
    html,
    "held as a pending signal until the wait took it",
  );
});

Deno.test("StepSignalWait: a receipt without heldAsPending has no pending note", () => {
  const html = renderToStaticMarkup(
    <StepSignalWait status="succeeded" wait={{ ...wait, receipt }} />,
  );
  assertEquals(html.includes("pending signal"), false);
});
