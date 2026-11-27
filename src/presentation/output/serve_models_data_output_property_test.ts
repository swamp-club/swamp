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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import type { ActiveRun } from "../../domain/models/active_run.ts";
import type { Sink } from "./json_stream.ts";
import { writeDoctorRunsLog, writeModelRunsLog } from "./model_runs_output.ts";
import { renderDataGet } from "../renderers/data_get.ts";
import { createDataListRenderer } from "../renderers/data_list.ts";
import { createDataQueryRenderer } from "../renderers/data_query.ts";
import {
  createModelLeaseAcquireRenderer,
  createModelLeaseStatusRenderer,
} from "../renderers/model_lease.ts";
import { createModelMethodHistoryLogsRenderer } from "../renderers/model_method_history_logs.ts";
import { createModelMethodRunRenderer } from "../renderers/model_method_run.ts";
import { createModelOutputDataRenderer } from "../renderers/model_output_data.ts";
import { createModelOutputLogsRenderer } from "../renderers/model_output_logs.ts";
import { createModelValidateRenderer } from "../renderers/model_validate.ts";
import { createReportDescribeRenderer } from "../renderers/report_describe.ts";
import { createReportGetRenderer } from "../renderers/report_get.ts";
import { createSummariseRenderer } from "../renderers/summarise.ts";
import { createVaultDescribeRenderer } from "../renderers/vault_describe.ts";
import { createVaultGetRenderer } from "../renderers/vault_get.ts";
import { createVaultReadSecretRenderer } from "../renderers/vault_read_secret.ts";
import { createVaultSearchRenderer } from "../renderers/vault_search.tsx";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;t\x07"),
    fc.fullUnicode(),
  ),
});

// a --server reply, a shared datastore or an extension may skip the validation these types assume
function texts<K extends string>(
  ...keys: K[]
): fc.Arbitrary<Record<K, string>> {
  return fc.array(text, { minLength: keys.length, maxLength: keys.length })
    .map((values) =>
      Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Record<
        K,
        string
      >
    );
}

function assertEscaped(
  output: string,
  single: readonly string[],
  multiLine: readonly string[] = [],
): void {
  assertNoControlCharacters(output);
  for (const value of single) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of multiLine) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

/** console.log lines and sink writes, in order */
async function captureAll(
  render: (sink: Sink) => Promise<void> | void,
): Promise<string> {
  const pieces: string[] = [];
  const decoder = new TextDecoder();
  const original = console.log;
  console.log = (message: string) => pieces.push(`${message}\n`);
  try {
    await render((bytes) => {
      pieces.push(decoder.decode(bytes));
      return Promise.resolve(bytes.length);
    });
  } finally {
    console.log = original;
  }
  return pieces.join("");
}

const RUNS = { numRuns: 50 };

Deno.test("data get: metadata and content another writer stored are escaped, and JSON keeps them raw", async () => {
  await fc.assert(
    fc.asyncProperty(
      texts(
        "name",
        "modelName",
        "modelType",
        "contentType",
        "lifetime",
        "gc",
        "tagKey",
        "tagValue",
        "ownerType",
        "ownerRef",
        "createdAt",
        "contentPath",
        "content",
      ),
      async (t) => {
        const data = {
          name: t.name,
          version: 1,
          modelName: t.modelName,
          modelType: t.modelType,
          contentType: t.contentType,
          size: 3,
          lifetime: t.lifetime,
          garbageCollection: t.gc,
          tags: { [t.tagKey]: t.tagValue },
          ownerDefinition: { ownerType: t.ownerType, ownerRef: t.ownerRef },
          createdAt: t.createdAt,
          contentPath: t.contentPath,
          content: t.content,
        } as never;
        assertEscaped(
          await captureAll((sink) => renderDataGet(data, "log", { sink })),
          [
            t.name,
            t.modelName,
            t.modelType,
            t.contentType,
            t.lifetime,
            t.gc,
            `${t.tagKey}`,
            t.tagValue,
            t.ownerType,
            t.ownerRef,
            t.createdAt,
            t.contentPath,
          ],
          [t.content],
        );
        const json = { value: t.content };
        assertEscaped(
          await captureAll((sink) =>
            renderDataGet(
              {
                ...(data as object),
                contentType: "application/json",
                content: JSON.stringify(json),
              } as never,
              "log",
              { sink },
            )
          ),
          [],
          [JSON.stringify(t.content)],
        );
        const out = await captureAll((sink) =>
          renderDataGet(data, "json", { sink })
        );
        assertEquals(JSON.parse(out).content, t.content);
      },
    ),
    RUNS,
  );
});

Deno.test("data list: names and versions another writer stored are escaped before the row is cut to the terminal", () => {
  fc.assert(
    fc.property(
      texts(
        "namespace",
        "modelName",
        "modelType",
        "type",
        "name",
        "contentType",
        "workflowName",
        "jobName",
        "stepName",
      ),
      (t) => {
        const model = captureRaw(() =>
          createDataListRenderer("log", true).handlers().completed({
            kind: "completed",
            data: {
              namespace: `n${t.namespace}`,
              modelName: t.modelName,
              modelType: t.modelType,
              groups: [{
                type: t.type,
                items: [{
                  name: t.name,
                  version: 1,
                  contentType: t.contentType,
                  size: 1,
                  createdAt: t.name,
                }],
              }],
            } as never,
          })
        );
        assertEscaped(model, [
          `n${t.namespace}`,
          t.modelName,
          t.modelType,
          t.type,
        ]);
        const workflow = captureRaw(() =>
          createDataListRenderer("log").handlers().completed({
            kind: "completed",
            data: {
              workflowId: "w",
              workflowName: t.workflowName,
              runId: t.name,
              groups: [{
                type: t.type,
                items: [{
                  name: t.name,
                  version: 1,
                  modelName: t.modelName,
                  jobName: t.jobName,
                  stepName: t.stepName,
                  size: 1,
                }],
              }],
            } as never,
          })
        );
        assertEscaped(workflow, [t.workflowName, t.type]);
      },
    ),
    RUNS,
  );
});

Deno.test("data query: table cells, projected values and the next cursor are escaped", async () => {
  await fc.assert(
    fc.asyncProperty(
      texts("name", "modelName", "specName", "dataType", "value", "cursor"),
      async (t) => {
        const render = (data: unknown) =>
          captureAll((sink) =>
            createDataQueryRenderer("log", false, { sink }).handlers()
              .completed({ kind: "completed", data: data as never })
          );
        assertEscaped(
          await render({
            predicate: "true",
            results: [{
              name: t.name,
              modelName: t.modelName,
              specName: t.specName,
              dataType: t.dataType,
              version: 1,
              size: 1,
              namespace: "",
            }],
            total: 1,
            limited: false,
            nextCursor: `c${t.cursor}`,
          }),
          [t.name, t.modelName, t.specName, t.dataType, `c${t.cursor}`],
        );
        assertEscaped(
          await render({
            predicate: "true",
            results: [],
            projected: {
              shape: "scalar",
              values: [t.value, { key: t.value }],
            },
            total: 2,
            limited: false,
          }),
          [],
          [t.value, JSON.stringify(t.value)],
        );
      },
    ),
    RUNS,
  );
});

Deno.test("model lease: a lease's behavior and lock key are escaped", () => {
  fc.assert(
    fc.property(texts("name", "type", "lockKey", "expiresAt"), (t) => {
      const lease = {
        lockKey: t.lockKey,
        fence: 1,
        holdMs: 60_000,
        expiresAt: t.expiresAt,
        state: "held",
      };
      assertEscaped(
        captureRaw(() =>
          createModelLeaseAcquireRenderer("log").handlers().completed({
            kind: "completed",
            data: {
              ...lease,
              existing: false,
              behavior: { name: t.name, type: t.type },
            },
          } as never)
        ),
        [t.name, t.type, t.lockKey, t.expiresAt],
      );
      assertEscaped(
        captureRaw(() =>
          createModelLeaseStatusRenderer("log").handlers().completed({
            kind: "completed",
            data: { leases: [lease] },
          } as never)
        ),
        [t.lockKey, t.expiresAt],
      );
    }),
    RUNS,
  );
});

Deno.test("model validate: validation names, errors and warning details from a --server reply are escaped, and JSON keeps them raw", () => {
  fc.assert(
    fc.property(
      texts(
        "modelName",
        "type",
        "name",
        "error",
        "expression",
        "suggestion",
        "key",
        "path",
        "envVar",
        "message",
      ),
      (t) => {
        const data = {
          modelId: "m",
          modelName: t.modelName,
          type: t.type,
          passed: false,
          validations: [
            { name: t.name, passed: false, error: t.error },
            {
              name: t.name,
              passed: false,
              expressionErrors: [{
                expression: t.expression,
                error: t.error,
                suggestion: `s${t.suggestion}`,
                availableKeys: [t.key],
              }],
            },
          ],
          warnings: [{
            name: t.name,
            message: t.message,
            envVars: [{ path: t.path, envVar: t.envVar }],
          }],
        };
        assertEscaped(
          captureRaw(() =>
            createModelValidateRenderer("log", "behavior").handlers()
              .completed({ kind: "completed", data } as never)
          ),
          [t.modelName, t.type, t.name, t.expression, t.key, t.path, t.envVar],
          [t.error, `s${t.suggestion}`, t.message],
        );
        const json = captureRaw(() =>
          createModelValidateRenderer("json", "behavior").handlers()
            .completed({ kind: "completed", data } as never)
        );
        assertEquals(JSON.parse(json), data);
      },
    ),
    RUNS,
  );
});

Deno.test("model method run: names, method output, warnings and errors an extension produced are escaped", () => {
  fc.assert(
    fc.property(
      texts(
        "definitionName",
        "modelType",
        "definitionPath",
        "modelName",
        "methodName",
        "line",
        "specName",
        "instanceName",
        "error",
        "message",
        "reportName",
        "reason",
      ),
      (t) => {
        const renderer = createModelMethodRunRenderer("log", {
          modelName: "m",
          methodName: "run",
        });
        const h = renderer.handlers();
        const run = {
          status: "failed",
          methodName: t.methodName,
          modelName: t.modelName,
          dataArtifacts: [],
        };
        const output = captureRaw(() => {
          h.auto_created({
            kind: "auto_created",
            definitionName: t.definitionName,
            modelType: t.modelType,
            definitionPath: t.definitionPath,
          } as never);
          h.model_resolved({
            kind: "model_resolved",
            modelName: t.modelName,
            methodName: t.methodName,
            modelType: t.modelType,
          } as never);
          h.executing({ kind: "executing", methodName: t.methodName } as never);
          h.method_output({ kind: "method_output", line: t.line } as never);
          h.method_event({
            kind: "method_event",
            event: {
              type: "schema_validation_warning",
              specName: t.specName,
              instanceName: t.instanceName,
              error: t.error,
            },
          } as never);
          h.method_event({
            kind: "method_event",
            event: { type: "stamped_tag_ignored", message: t.message },
          } as never);
          h.report_failed({
            kind: "report_failed",
            reportName: t.reportName,
            error: t.error,
          } as never);
          h.completed({ kind: "completed", run } as never);
          h.cancelled({
            kind: "cancelled",
            reason: `r${t.reason}`,
            run,
          } as never);
        });
        assertEscaped(
          output,
          [
            t.definitionName,
            t.modelType,
            t.definitionPath,
            t.modelName,
            t.methodName,
            t.specName,
            t.instanceName,
            t.reportName,
          ],
          [t.line, t.error, t.message, `r${t.reason}`],
        );
      },
    ),
    RUNS,
  );
});

Deno.test("report describe and report get: report names, labels and sources are escaped", () => {
  fc.assert(
    fc.property(
      texts(
        "name",
        "description",
        "scope",
        "label",
        "workflowName",
        "modelName",
        "modelType",
        "varySuffix",
        "createdAt",
      ),
      (t) => {
        assertEscaped(
          captureRaw(() =>
            createReportDescribeRenderer("log").handlers().completed({
              kind: "completed",
              data: {
                name: t.name,
                description: t.description,
                scope: t.scope,
                labels: [t.label],
              },
            } as never)
          ),
          [t.name, t.scope, t.label],
          [t.description],
        );
        const report = {
          reportName: t.name,
          reportScope: t.scope,
          modelId: "m",
          modelName: t.modelName,
          modelType: t.modelType,
          varySuffix: `v${t.varySuffix}`,
          version: 1,
          createdAt: t.createdAt,
          dataName: "d",
          markdown: "",
          json: {},
        };
        for (const mode of ["log", "markdown"] as const) {
          assertEscaped(
            captureRaw(() =>
              createReportGetRenderer(mode).handlers().completed({
                kind: "completed",
                data: report,
              } as never)
            ),
            [
              t.name,
              t.scope,
              t.modelName,
              t.modelType,
              `v${t.varySuffix}`,
              t.createdAt,
            ],
          );
          assertEscaped(
            captureRaw(() =>
              createReportGetRenderer(mode).handlers().completed({
                kind: "completed",
                data: { ...report, workflowName: `w${t.workflowName}` },
              } as never)
            ),
            [`w${t.workflowName}`],
          );
        }
      },
    ),
    RUNS,
  );
});

Deno.test("summarise: behavior, method, workflow and step names and errors are escaped before padding", () => {
  fc.assert(
    fc.property(
      texts(
        "modelName",
        "type",
        "method",
        "triggeredBy",
        "error",
        "startedAt",
        "workflowName",
        "step",
        "jobName",
        "stepModel",
        "modelType",
      ),
      (t) => {
        const summary = {
          since: "1d",
          methodExecutions: [{
            modelName: t.modelName,
            type: t.type,
            total: 1,
            succeeded: 0,
            failed: 1,
            methods: [{
              method: t.method,
              total: 1,
              succeeded: 0,
              failed: 1,
              truncated: false,
              runs: [{
                startedAt: t.startedAt,
                status: "failed",
                triggeredBy: t.triggeredBy,
                error: `e${t.error}`,
              }],
            }],
          }],
          workflows: [{
            workflowName: t.workflowName,
            total: 1,
            succeeded: 0,
            failed: 1,
            truncated: false,
            runs: [{
              startedAt: t.startedAt,
              status: "failed",
              firstFailedStep: `f${t.step}`,
              steps: [{
                jobName: t.jobName,
                stepName: `f${t.step}`,
                modelName: `m${t.stepModel}`,
                status: "failed",
                error: `e${t.error}`,
              }],
            }],
          }],
          data: {
            totalItems: 1,
            totalVersions: 1,
            uniqueModels: 1,
            byModelType: [{ modelType: t.modelType, items: 1, versions: 1 }],
          },
        };
        const render = (verbosity: "verbose" | "normal") =>
          captureRaw(() =>
            createSummariseRenderer("log", verbosity).handlers().completed({
              kind: "completed",
              data: { status: "activity", summary, sinceLabel: "1d" },
            } as never)
          );
        assertEscaped(
          render("verbose"),
          [
            t.modelName,
            t.type,
            t.method,
            t.triggeredBy,
            t.startedAt,
            t.workflowName,
            `f${t.step}`,
            t.jobName,
            `m${t.stepModel}`,
            t.modelType,
          ],
          [`e${t.error}`],
        );
        assertEscaped(render("normal"), [`e${t.error}`]);
      },
    ),
    RUNS,
  );
});

function activeRun(t: Record<string, string>): ActiveRun {
  return {
    id: t.id,
    runKind: "method",
    modelType: t.modelType,
    methodName: t.methodName,
    workflowName: null,
    pid: 1,
    hostname: t.hostname,
    status: "running",
    startedAt: new Date(),
    heartbeatAt: new Date(),
    initiatedBy: t.initiatedBy,
    interruptReason: t.reason,
    autoContinuedFrom: null,
    isStale: () => false,
  } as unknown as ActiveRun;
}

Deno.test("model runs and doctor runs: run rows, progress and webhook admissions read from a shared datastore are escaped", () => {
  fc.assert(
    fc.property(
      texts(
        "id",
        "modelType",
        "methodName",
        "hostname",
        "initiatedBy",
        "reason",
        "path",
        "error",
        "scope",
        "phase",
        "worker",
        "receipt",
        "workflow",
      ),
      (t) => {
        assertEscaped(
          captureRaw(() => writeModelRunsLog([activeRun(t)])),
          [
            t.id.slice(0, 8),
            t.modelType,
            t.methodName,
            t.hostname,
            t.initiatedBy,
            t.reason,
          ],
        );
        const output = captureRaw(() =>
          writeDoctorRunsLog(
            [activeRun(t)],
            [activeRun(t)],
            0,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            t.error,
            new Map([[t.id, {
              progressScope: t.scope,
              progress: [{
                scope: "method",
                model: t.modelType,
                method: t.methodName,
                phase: t.phase,
                phaseElapsedMs: 1,
                lastProgressAt: t.scope,
                worker: `w${t.worker}`,
              }],
            }]]) as never,
            [{
              receiptId: t.receipt,
              workflow: t.workflow,
              phase: t.phase,
              phaseElapsedMs: 1,
              lastProgressAt: t.scope,
              blockingRunIds: [t.id],
              unknownBlockers: 0,
            }] as never,
            {
              runs: [{ runId: t.id, path: t.path, reason: t.reason }],
              reaped: 0,
            },
          )
        );
        assertEscaped(
          output,
          [
            t.modelType,
            t.methodName,
            t.hostname,
            t.id,
            t.path,
            t.scope,
            t.phase,
            `w${t.worker}`,
            t.receipt,
            t.workflow,
          ],
          [t.error, t.reason],
        );
      },
    ),
    RUNS,
  );
});

Deno.test("model output logs and method history logs: each log line an extension wrote is escaped", () => {
  fc.assert(
    fc.property(texts("line", "path", "outputId"), (t) => {
      assertEscaped(
        captureRaw(() =>
          createModelOutputLogsRenderer("log").handlers().completed({
            kind: "completed",
            data: { lines: [t.line] },
          } as never)
        ),
        [],
        [t.line],
      );
      const history = createModelMethodHistoryLogsRenderer("log").handlers();
      assertEscaped(
        captureRaw(() => {
          history.completed({
            kind: "completed",
            data: { type: "log", log: { path: t.path, lines: [t.line] } },
          } as never);
          history.completed({
            kind: "completed",
            data: {
              type: "empty_log",
              info: { path: t.path, outputId: t.outputId, methodName: "m" },
            },
          } as never);
          history.completed({
            kind: "completed",
            data: {
              type: "no_log_file",
              info: { outputId: t.outputId, modelName: "m", methodName: "m" },
            },
          } as never);
        }),
        [t.path, t.outputId.slice(0, 8)],
        [t.line],
      );
    }),
    RUNS,
  );
});

Deno.test("model output data: string and JSON data are escaped on a terminal and byte-exact when piped", async () => {
  await fc.assert(
    fc.asyncProperty(text, async (value) => {
      const render = (data: unknown, isTerminal: boolean) =>
        captureAll((sink) =>
          createModelOutputDataRenderer("log", {
            sink,
            isTerminal: () => isTerminal,
          }).handlers().completed({
            kind: "completed",
            data: { data, contentEncoding: "utf-8" },
          } as never)
        );
      assertEscaped(await render(value, true), [], [value]);
      assertEquals(await render(value, false), `${value}\n`);
      assertEscaped(
        await render({ value }, true),
        [],
        [JSON.stringify(value)],
      );
      assertEquals(
        await render({ value }, false),
        `${JSON.stringify({ value }, null, 2)}\n`,
      );
    }),
    RUNS,
  );
});

Deno.test("vault read secret: the value is escaped on a terminal and byte-exact when piped", () => {
  fc.assert(
    fc.property(text, (value) => {
      const event = { kind: "completed", data: { value } } as never;
      assertEscaped(
        captureRaw(() =>
          createVaultReadSecretRenderer("log", () => true).handlers()
            .completed(event)
        ),
        [],
        [value],
      );
      const written: Uint8Array[] = [];
      const original = Deno.stdout.writeSync.bind(Deno.stdout);
      Deno.stdout.writeSync = (bytes: Uint8Array): number => {
        written.push(bytes.slice());
        return bytes.length;
      };
      try {
        createVaultReadSecretRenderer("log", () => false).handlers()
          .completed(event);
      } finally {
        Deno.stdout.writeSync = original;
      }
      const bytes = new Uint8Array(written.flatMap((b) => [...b]));
      assertEquals(new TextDecoder().decode(bytes), value);
    }),
    RUNS,
  );
});

Deno.test("vault search, get and describe: vault names, ids and config are escaped in log mode, and JSON keeps them raw", async () => {
  await fc.assert(
    fc.asyncProperty(texts("name", "type", "id", "config"), async (t) => {
      assertEscaped(
        await captureAll(() =>
          createVaultSearchRenderer("log", undefined, { interactive: false })
            .handlers().completed({
              kind: "completed",
              data: {
                query: "",
                results: [{ name: t.name, type: t.type, id: t.id }],
              },
            } as never)
        ),
        [t.name, t.type, t.id],
      );
      const vault = { name: t.name, type: t.type, config: { key: t.config } };
      for (
        const handlers of [
          createVaultGetRenderer("log").handlers(),
          createVaultDescribeRenderer("log").handlers(),
        ]
      ) {
        assertEscaped(
          captureRaw(() =>
            handlers.completed({ kind: "completed", data: vault } as never)
          ),
          [],
          [JSON.stringify(t.name), JSON.stringify(t.config)],
        );
      }
      const json = captureRaw(() =>
        createVaultGetRenderer("json").handlers().completed({
          kind: "completed",
          data: vault,
        } as never)
      );
      assertEquals(JSON.parse(json), vault);
    }),
    RUNS,
  );
});
