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
import { resetConfirmText, ScheduleControls } from "./ScheduleControls.tsx";
import { ScheduleEditorForm } from "./ScheduleEditorForm.tsx";

const noop = () => {};
const handlers = {
  onPause: noop,
  onResume: noop,
  onEdit: noop,
  onReset: noop,
};

Deno.test("ScheduleControls: an active schedule offers Pause and Edit", () => {
  const html = renderToStaticMarkup(
    <ScheduleControls
      workflowName="deploy"
      paused={false}
      canReset={false}
      {...handlers}
    />,
  );
  assertStringIncludes(html, ">Pause</button>");
  assertStringIncludes(html, ">Edit</button>");
  assertEquals(html.includes(">Reset</button>"), false);
  assertEquals(html.includes("disabled"), false);
});

Deno.test("ScheduleControls: a paused override offers Resume and Reset", () => {
  const html = renderToStaticMarkup(
    <ScheduleControls
      workflowName="deploy"
      paused
      canReset
      {...handlers}
    />,
  );
  assertStringIncludes(html, ">Resume</button>");
  assertStringIncludes(html, 'aria-pressed="true"');
  assertStringIncludes(html, ">Reset</button>");
});

Deno.test("ScheduleControls: no pause control when serve can't pause", () => {
  const html = renderToStaticMarkup(
    <ScheduleControls workflowName="deploy" canReset={false} {...handlers} />,
  );
  assertEquals(html.includes("Pause"), false);
  assertEquals(html.includes("Resume"), false);
});

Deno.test("ScheduleControls: a change in flight disables every control", () => {
  const html = renderToStaticMarkup(
    <ScheduleControls
      workflowName="deploy"
      paused={false}
      canReset
      pending="pause"
      {...handlers}
    />,
  );
  assertStringIncludes(html, "Pausing…");
  assertEquals(html.match(/disabled=""/g)?.length, 3);
});

Deno.test("ScheduleControls: announces success and alerts on refusal", () => {
  const ok = renderToStaticMarkup(
    <ScheduleControls
      workflowName="deploy"
      paused={false}
      canReset={false}
      feedback={{ tone: "success", text: "Resumed." }}
      {...handlers}
    />,
  );
  assertStringIncludes(ok, 'aria-live="polite"');
  assertStringIncludes(ok, "Resumed.");
  assertEquals(ok.includes('role="alert"'), false);

  const refused = renderToStaticMarkup(
    <ScheduleControls
      workflowName="deploy"
      paused={false}
      canReset={false}
      feedback={{
        tone: "danger",
        text: "You don't have permission to pause the schedule of deploy.",
      }}
      {...handlers}
    />,
  );
  assertStringIncludes(refused, 'role="alert"');
  assertStringIncludes(refused, "You don&#x27;t have permission");
});

// ── ScheduleEditorForm ──────────────────────────────────────────────────

const NOW = Date.parse("2026-10-12T20:30:00.000Z");

function renderForm(
  over: Partial<Parameters<typeof ScheduleEditorForm>[0]> = {},
): string {
  return renderToStaticMarkup(
    <ScheduleEditorForm
      workflowName="deploy"
      initialSchedule="*/5 * * * *"
      initialInputs={{ region: "eu" }}
      builtInSchedule="0 9 * * 1"
      saving={false}
      onSave={noop}
      onCancel={noop}
      now={NOW}
      timeZone="UTC"
      {...over}
    />,
  );
}

Deno.test("ScheduleEditorForm: describes the schedule and previews five runs", () => {
  const html = renderForm();
  assertStringIncludes(html, "Every 5 minutes");
  assertStringIncludes(html, "Next 5 runs");
  assertStringIncludes(html, "(UTC)");
  assertEquals(html.match(/<li>/g)?.length, 5);
  assertStringIncludes(html, "in 5m");
  assertStringIncludes(html, "&quot;region&quot;: &quot;eu&quot;");
});

Deno.test("ScheduleEditorForm: Save is off until something changes", () => {
  const html = renderForm();
  assertStringIncludes(
    html,
    'type="submit" class="trig-btn primary" disabled=""',
  );
});

Deno.test("ScheduleEditorForm: an invalid expression explains itself and blocks Save", () => {
  const html = renderForm({ initialSchedule: "61 * * * *" });
  assertStringIncludes(html, 'aria-invalid="true"');
  assertStringIncludes(html, "minute 61 is out of range (0–59)");
  assertEquals(html.includes("Next 5 runs"), false);
});

Deno.test("ScheduleEditorForm: offers presets and the workflow file's schedule", () => {
  const html = renderForm();
  assertStringIncludes(html, "Every 5 min");
  assertStringIncludes(
    html,
    'Workflow file: <span class="mono">0 9 * * 1</span>',
  );
  assertStringIncludes(html, 'aria-pressed="true"');
});

Deno.test("ScheduleEditorForm: shows a save error and the saving state", () => {
  const html = renderForm({
    saving: true,
    error: "Couldn't change the schedule: boom",
  });
  assertStringIncludes(html, 'role="alert"');
  assertStringIncludes(html, "Couldn&#x27;t change the schedule: boom");
  assertStringIncludes(html, "Saving…");
});

Deno.test("resetConfirmText: says a paused schedule stays paused", () => {
  assertStringIncludes(resetConfirmText(true), "It stays paused.");
  assertEquals(resetConfirmText(false).includes("paused"), false);
  assertEquals(resetConfirmText(undefined).includes("paused"), false);
});
