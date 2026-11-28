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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import React from "react";
import { render } from "ink-testing-library";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "../output/terminal_output_test_helpers.ts";
import { createDataSearchRenderer } from "./data_search.tsx";
import { createModelOutputSearchRenderer } from "./model_output_search.tsx";
import { createModelSearchRenderer } from "./model_search.tsx";
import { createReportSearchRenderer } from "./report_search.tsx";
import { createWorkflowHistorySearchRenderer } from "./workflow_history_search.tsx";
import {
  createWorkflowRunSearchRenderer,
  reapedRunsLine,
} from "./workflow_run_search.tsx";
import { createWorkflowSearchRenderer } from "./workflow_search.tsx";
import { AutocompleteDropdown } from "./data_query_tui/autocomplete_dropdown.tsx";

await initializeLogging({});

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;title\x07"),
    fc.fullUnicode(),
  ),
});

const NUM_RUNS = 50;
const NON_INTERACTIVE = { interactive: false };

function assertEscaped(output: string, printed: readonly string[]): void {
  assertNoControlCharacters(output);
  for (const value of printed) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

type Handlers = Record<string, (event: unknown) => unknown>;

/** the --server plain list: completed prints synchronously through writeOutput */
function listed(renderer: { handlers: () => unknown }, data: object): string {
  return captureRaw(() => {
    (renderer.handlers() as Handlers).completed({ kind: "completed", data });
  });
}

const runItem = fc.record({
  workflowName: text,
  runId: text,
  status: text,
  tagKey: text,
  tagValue: text,
  inputKey: text,
  inputValue: text,
});

Deno.test("data, behavior output and behavior search lists: no remote control character reaches the terminal", () => {
  fc.assert(
    fc.property(
      fc.record({
        name: text,
        modelName: text,
        type: text,
        methodName: text,
        status: text,
        definitionId: text,
        startedAt: text,
      }),
      (f) => {
        // data search prints through the markdown renderer, which escapes it whole
        assertNoControlCharacters(
          listed(createDataSearchRenderer("log", undefined, NON_INTERACTIVE), {
            query: "",
            results: [{
              id: "d",
              name: f.name,
              version: 1,
              contentType: f.type,
              type: f.type,
              lifetime: f.type,
              lifecycle: "active",
              ownerType: f.type,
              ownerRef: f.name,
              modelId: "m",
              modelName: f.modelName,
              modelType: f.type,
              streaming: false,
              size: 1,
              createdAt: new Date(0).toISOString(),
              tags: { [f.name]: f.modelName },
              workflowTag: f.name,
            }],
          }),
        );

        assertEscaped(
          listed(
            createModelOutputSearchRenderer(
              "log",
              undefined,
              undefined,
              NON_INTERACTIVE,
            ),
            {
              query: "",
              results: [{
                id: "o",
                definitionId: f.definitionId,
                modelName: f.modelName,
                type: f.type,
                methodName: f.methodName,
                status: f.status,
                startedAt: f.startedAt,
              }],
            },
          ),
          [
            f.modelName,
            f.type,
            f.methodName,
            f.status,
            f.definitionId,
            f.startedAt,
          ],
        );

        assertEscaped(
          listed(
            createModelSearchRenderer("log", {}, undefined, NON_INTERACTIVE),
            { query: "", results: [{ id: "m", name: f.name, type: f.type }] },
          ),
          [f.name, f.type],
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("report and workflow search lists: no remote control character reaches the terminal, and JSON keeps the values", () => {
  fc.assert(
    fc.property(
      fc.record({
        reportName: text,
        reportScope: text,
        modelName: text,
        modelType: text,
        workflowName: text,
        varySuffix: text,
        createdAt: text,
        name: text,
      }),
      (f) => {
        const report = {
          reportName: f.reportName,
          reportScope: f.reportScope,
          modelId: "m",
          modelName: f.modelName,
          modelType: f.modelType,
          version: 1,
          createdAt: f.createdAt,
          workflowName: f.workflowName,
          dataName: "d",
          varySuffix: f.varySuffix,
        };
        assertEscaped(
          listed(
            createReportSearchRenderer("log", "", undefined, NON_INTERACTIVE),
            { reports: [report] },
          ),
          [
            f.reportName,
            f.reportScope,
            f.modelName,
            f.modelType,
            f.workflowName,
            f.varySuffix,
            f.createdAt,
          ],
        );
        const json = JSON.parse(
          listed(createReportSearchRenderer("json", ""), { reports: [report] }),
        );
        assertEquals(json.results[0].reportName, f.reportName);

        assertEscaped(
          listed(
            createWorkflowSearchRenderer("log", undefined, NON_INTERACTIVE),
            {
              query: "",
              results: [{
                id: "w",
                name: f.name,
                jobCount: 1,
                stepCount: 1,
                hasInputs: false,
              }],
            },
          ),
          [f.name],
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("workflow run and history search lists: no remote control character in a run, its tags, inputs, skipped records or retention reaches the terminal", () => {
  fc.assert(
    fc.property(runItem, text, text, (r, reason, cutoff) => {
      const item = {
        workflowName: r.workflowName,
        workflowId: "wf",
        runId: r.runId,
        status: r.status,
        tags: { [r.tagKey]: r.tagValue },
        inputs: { [r.inputKey]: r.inputValue },
      };
      const printed = [
        r.workflowName,
        r.runId,
        r.status,
        r.tagKey,
        r.tagValue,
        r.inputKey,
        r.inputValue,
      ];
      const reaped = { cutoff, retention: reason };
      const runs = listed(
        createWorkflowRunSearchRenderer("log", undefined, NON_INTERACTIVE),
        { query: "", results: [item], reapedBefore: reaped },
      );
      assertEscaped(runs, [...printed, cutoff, reason]);
      assert(runs.includes(escapeControlCharacters(reapedRunsLine(reaped))));

      assertEscaped(
        listed(
          createWorkflowHistorySearchRenderer(
            "log",
            undefined,
            NON_INTERACTIVE,
          ),
          {
            query: "",
            results: [item],
            skippedWorkflows: [{
              workflowName: r.workflowName,
              runId: r.runId,
              reason,
            }],
          },
        ),
        [...printed, reason],
      );
    }),
    { numRuns: NUM_RUNS },
  );
});

Deno.test({
  name:
    "AutocompleteDropdown: no control character in a completion's label or detail reaches the terminal",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    fc.assert(
      fc.property(text, text, (label, detail) => {
        const { lastFrame, unmount } = render(
          React.createElement(AutocompleteDropdown, {
            items: [{ text: label, label, detail, kind: "value" }],
            selectedIndex: 0,
            offsetLeft: 0,
          }),
        );
        try {
          assertNoControlCharacters(lastFrame() ?? "");
        } finally {
          unmount();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  },
});
