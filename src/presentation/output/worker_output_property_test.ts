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
import type { PrunableWorker } from "../../libswamp/worker/prune.ts";
import type {
  WorkerListData,
  WorkerTokenListData,
} from "../../libswamp/worker/list.ts";
import type { WorkerQueueListData } from "../../libswamp/worker/queue_list.ts";
import type { WorkerTokenCreateData } from "../../libswamp/worker/token_create.ts";
import type { WorkerTokenRevokeData } from "../../libswamp/worker/token_revoke.ts";
import type { WorkerTokenRotateData } from "../../libswamp/worker/token_rotate.ts";
import type { WorkerTokenRevealData } from "../../libswamp/worker/token_reveal.ts";
import type { WorkerStatusEvent } from "../../worker/connect.ts";
import type { WorkerVerifyData } from "../../serve/protocol.ts";
import type { ServeFingerprintData } from "../../libswamp/serve/fingerprint.ts";
import {
  renderWorkerList,
  renderWorkerPrunePreview,
  renderWorkerQueue,
  renderWorkerStatus,
  renderWorkerTokenCreate,
  renderWorkerTokenList,
  renderWorkerTokenReveal,
  renderWorkerTokenRevoke,
  renderWorkerTokenRotate,
  renderWorkerVerify,
} from "./worker_output.ts";
import { renderServeFingerprint } from "./serve_fingerprint_output.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const unit = fc.oneof(
  fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
  fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;t\x07"),
  fc.fullUnicode(),
);
const text = fc.string({ unit });
// a table trims its last column, so a value printed there ends in a visible character
const lastColumn = text.map((value) => `${value}.`);

const RUNS = { numRuns: 50 };

// the serve reply is cast to these types unchecked, so every field is arbitrary text
function cast<T>(value: unknown): T {
  return value as T;
}

function assertEscaped(
  output: string,
  printed: readonly string[],
  printedAsText: readonly string[] = [],
): void {
  assertNoControlCharacters(output);
  for (const value of printed) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of printedAsText) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

const tokenArb = fc.record({
  name: text,
  expiresAt: text,
  labelKey: text,
  labelValue: lastColumn,
  vaultName: text,
  secretKey: text,
  token: text,
  state: text,
  machineId: text,
  revokedAt: text,
  disconnected: text,
  rotatedWorker: text,
  notRotatedWorker: text,
  reason: text,
  predecessorExpiresAt: text,
});

Deno.test("worker token renderers: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(tokenArb, (t) => {
      const labels = { [t.labelKey]: t.labelValue };
      const label = `${t.labelKey}=${t.labelValue}`;
      assertEscaped(
        captureRaw(() =>
          renderWorkerTokenCreate(
            cast<WorkerTokenCreateData>({
              name: t.name,
              expiresAt: t.expiresAt,
              maxEnrollments: 1,
              labels,
              vaultRef: { vaultName: t.vaultName, secretKey: t.secretKey },
              token: t.token,
            }),
            "log",
          )
        ),
        [t.name, t.expiresAt, label, t.vaultName, t.secretKey, t.token],
      );

      const list = cast<WorkerTokenListData>({
        tokens: [{
          name: t.name,
          effectiveState: t.state,
          expiresAt: t.expiresAt,
          maxEnrollments: 1,
          bindings: [{ machineId: t.machineId }],
          bindingCount: 1,
          labels,
        }],
      });
      assertEscaped(
        captureRaw(() => renderWorkerTokenList(list, "log")),
        [t.name, t.state, t.expiresAt, t.machineId, label],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderWorkerTokenList(list, "json"))),
        list.tokens,
      );

      assertEscaped(
        captureRaw(() =>
          renderWorkerTokenRevoke(
            cast<WorkerTokenRevokeData>({
              name: t.name,
              alreadyRevoked: false,
              revokedAt: t.revokedAt,
              disconnectedWorkers: [t.disconnected],
            }),
            "log",
          )
        ),
        [t.name, t.revokedAt, t.disconnected],
      );

      const rotate = cast<WorkerTokenRotateData>({
        name: t.name,
        token: t.token,
        expiresAt: t.expiresAt,
        predecessorExpiresAt: t.predecessorExpiresAt,
        delivered: false,
        rotated: [{ worker: t.rotatedWorker, persisted: false }],
        notRotated: [{ worker: t.notRotatedWorker, reason: t.reason }],
        unconnectedBindings: 1,
        retiredBindings: 1,
      });
      assertEscaped(
        captureRaw(() => renderWorkerTokenRotate(rotate, "log")),
        [
          t.name,
          t.token,
          t.expiresAt,
          t.predecessorExpiresAt,
          t.rotatedWorker,
          t.notRotatedWorker,
          t.reason,
        ],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderWorkerTokenRotate(rotate, "json"))),
        rotate,
      );

      assertEscaped(
        captureRaw(() =>
          renderWorkerTokenReveal(
            cast<WorkerTokenRevealData>({
              name: t.name,
              expiresAt: t.expiresAt,
              expired: true,
              token: t.token,
            }),
            "log",
          )
        ),
        [t.name, t.expiresAt, t.token],
      );
    }),
    RUNS,
  );
});

const workerArb = fc.record({
  name: text,
  status: text,
  labelKey: text,
  labelValue: text,
  platform: text,
  arch: text,
  lastSeenAt: lastColumn,
  requirement: text,
  stepName: text,
  modelType: text,
  queuedAt: text,
  error: lastColumn,
  tokenName: text,
  disconnectedAt: text,
});

Deno.test("worker list, queue, verify and prune renderers: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(workerArb, (w) => {
      const list = cast<WorkerListData>({
        workers: [{
          name: w.name,
          status: w.status,
          activeDispatchIds: [],
          capacity: 1,
          labels: { [w.labelKey]: w.labelValue },
          platform: w.platform,
          arch: w.arch,
          lastSeenAt: w.lastSeenAt,
        }],
      });
      assertEscaped(captureRaw(() => renderWorkerList(list, "log")), [
        w.name,
        w.status,
        `${w.labelKey}=${w.labelValue}`,
        `${w.platform}/${w.arch}`,
        w.lastSeenAt,
      ]);
      assertEquals(
        JSON.parse(captureRaw(() => renderWorkerList(list, "json"))),
        list,
      );

      assertEscaped(
        captureRaw(() =>
          renderWorkerQueue(
            cast<WorkerQueueListData>({
              items: [{
                requirement: w.requirement,
                stepName: w.stepName,
                modelType: w.modelType,
                methodName: "m",
                queuedAt: w.queuedAt,
                ageMs: 5_000,
              }],
            }),
            "log",
          )
        ),
        [w.requirement, w.stepName, w.modelType, w.queuedAt],
      );

      const verify = cast<WorkerVerifyData>({
        workers: [
          {
            name: w.name,
            status: "error",
            platform: w.platform,
            arch: w.arch,
            error: w.error,
          },
          { name: w.name, status: "fail", failures: [w.error] },
        ],
        total: 2,
        passed: 0,
        failed: 2,
      });
      assertEscaped(captureRaw(() => renderWorkerVerify(verify, "log")), [
        w.name,
        w.platform,
        w.arch,
        w.error,
      ]);
      assertEquals(
        JSON.parse(captureRaw(() => renderWorkerVerify(verify, "json"))),
        verify,
      );

      assertEscaped(
        captureRaw(() =>
          renderWorkerPrunePreview(
            [cast<PrunableWorker>({
              name: w.name,
              tokenName: w.tokenName,
              disconnectedAt: w.disconnectedAt,
            })],
            true,
            "log",
          )
        ),
        [w.name, w.tokenName, w.disconnectedAt],
      );
    }),
    RUNS,
  );
});

Deno.test("renderWorkerStatus: no server-supplied control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(
      fc.record({
        workerId: text,
        reason: text,
        dispatchId: text,
        workflowName: text.filter((name) => name.length > 0),
        stepName: text.filter((name) => name.length > 0),
        modelType: text,
        methodName: text,
        error: text.filter((error) => error.length > 0),
      }),
      (s) => {
        const events = cast<WorkerStatusEvent[]>([
          { kind: "enrolled", workerId: s.workerId, reconnect: false },
          { kind: "disconnected", reason: s.reason },
          { kind: "stopped", reason: s.reason },
          { kind: "draining", reason: s.reason },
          {
            kind: "dispatch_started",
            dispatchId: s.dispatchId,
            workflowName: s.workflowName,
            stepName: s.stepName,
            modelType: s.modelType,
            methodName: s.methodName,
          },
          {
            kind: "dispatch_finished",
            dispatchId: s.dispatchId,
            modelType: s.modelType,
            methodName: s.methodName,
            status: "failed",
            durationMs: 3,
            error: s.error,
          },
        ]);
        const output = captureRaw(() => {
          for (const event of events) renderWorkerStatus(event, "log");
        });
        assertEscaped(
          output,
          [
            s.workerId,
            s.reason,
            s.workflowName,
            s.stepName,
            `${s.modelType}.${s.methodName}`,
          ],
          [s.error],
        );
        assertEquals(
          JSON.parse(captureRaw(() => renderWorkerStatus(events[5], "json"))),
          events[5],
        );
      },
    ),
    RUNS,
  );
});

Deno.test("renderServeFingerprint: no worker-supplied control character reaches the terminal, and every printed key is still there escaped", () => {
  fc.assert(
    fc.property(text, text, (version, labelKey) => {
      const data = cast<ServeFingerprintData>({
        hash: "a".repeat(64),
        fingerprint: {
          swampVersion: "20261125.1629.0",
          platform: "linux",
          arch: "x86_64",
          serveYamlVersion: 2,
          deploymentMode: "durable",
          datastoreKind: "@swamp/s3-datastore",
          datastoreFormat: "v3",
          vaultKinds: [],
          authMode: "oauth",
          tls: true,
          remoteOnly: true,
          loopbackOnly: false,
          federationRole: "hub",
          extensions: [],
          settingsHash: "b".repeat(64),
          workers: {
            total: 2,
            byVersion: { [version]: 1 },
            byLabelKey: { [labelKey]: 1 },
          },
          team: null,
          startedAt: null,
          ready: null,
        },
      });
      assertEscaped(
        captureRaw(() => renderServeFingerprint(data, "log")),
        [version, labelKey],
      );
      assertEquals(
        JSON.parse(captureRaw(() => renderServeFingerprint(data, "json"))),
        data,
      );
    }),
    RUNS,
  );
});
