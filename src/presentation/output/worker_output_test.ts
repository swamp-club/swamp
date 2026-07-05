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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type {
  WorkerListData,
  WorkerQueueListData,
  WorkerTokenCreateData,
  WorkerTokenListData,
  WorkerTokenRevokeData,
} from "../../libswamp/mod.ts";
import {
  renderWorkerList,
  renderWorkerQueue,
  renderWorkerStatus,
  renderWorkerTokenCreate,
  renderWorkerTokenList,
  renderWorkerTokenRevoke,
  renderWorkerVerify,
} from "./worker_output.ts";
import type { WorkerVerifyData } from "../../cli/commands/worker_verify.ts";

function captureLogs(run: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

const createData: WorkerTokenCreateData = {
  name: "ci-runner-3",
  token: "swamp-token-plaintext",
  expiresAt: "2026-06-10T00:00:00.000Z",
  maxEnrollments: 1,
  vaultRef: { vaultName: "main-vault", secretKey: "worker-token-ci-runner-3" },
};

Deno.test("renderWorkerTokenCreate: log mode shows the token once with warning", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerTokenCreate(createData, "log")),
  );
  assertStringIncludes(output, "Token: ci-runner-3");
  assertStringIncludes(output, "Expires: 2026-06-10T00:00:00.000Z");
  assertStringIncludes(output, "main-vault");
  assertStringIncludes(output, "worker-token-ci-runner-3");
  assertStringIncludes(output, "swamp-token-plaintext");
  assertStringIncludes(output, "shown once");
});

Deno.test("renderWorkerTokenCreate: json mode emits the structured record", () => {
  const output = captureLogs(() => renderWorkerTokenCreate(createData, "json"));
  const parsed = JSON.parse(output) as WorkerTokenCreateData;
  assertEquals(parsed.name, "ci-runner-3");
  assertEquals(parsed.token, "swamp-token-plaintext");
  assertEquals(parsed.expiresAt, "2026-06-10T00:00:00.000Z");
  assertEquals(parsed.vaultRef, {
    vaultName: "main-vault",
    secretKey: "worker-token-ci-runner-3",
  });
});

const tokenListData: WorkerTokenListData = {
  tokens: [
    {
      name: "ci-runner-3",
      state: "enrolled",
      effectiveState: "enrolled",
      createdAt: "2026-06-09T00:00:00.000Z",
      expiresAt: "2026-06-10T00:00:00.000Z",
      maxEnrollments: 1,
      bindingCount: 1,
      bindings: [{
        machineId: "machine-42",
        enrolledAt: "2026-06-09T01:00:00.000Z",
      }],
      vaultName: "main-vault",
      secretKey: "worker-token-ci-runner-3",
    },
    {
      name: "stale",
      state: "unused",
      effectiveState: "expired",
      createdAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-06-02T00:00:00.000Z",
      maxEnrollments: 1,
      bindingCount: 0,
      bindings: [],
      vaultName: "main-vault",
      secretKey: "worker-token-stale",
    },
  ],
  count: 2,
};

Deno.test("renderWorkerTokenList: log mode renders the table with display state", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerTokenList(tokenListData, "log")),
  );
  assertStringIncludes(output, "NAME");
  assertStringIncludes(output, "STATE");
  assertStringIncludes(output, "EXPIRES");
  assertStringIncludes(output, "ENROLLMENTS");
  assertStringIncludes(output, "ci-runner-3");
  assertStringIncludes(output, "enrolled");
  assertStringIncludes(output, "machine-42");
  // Display-level expiry overlay
  assertStringIncludes(output, "expired");
});

Deno.test("renderWorkerTokenList: log mode shows empty-state hint", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerTokenList({ tokens: [], count: 0 }, "log")),
  );
  assertStringIncludes(output, "No enrollment tokens found.");
  assertStringIncludes(output, "swamp worker token create");
});

Deno.test("renderWorkerTokenList: json mode emits the array of records", () => {
  const output = captureLogs(() =>
    renderWorkerTokenList(tokenListData, "json")
  );
  const parsed = JSON.parse(output) as WorkerTokenListData["tokens"];
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].name, "ci-runner-3");
  assertEquals(parsed[1].effectiveState, "expired");
  assertEquals(parsed[1].state, "unused");
});

Deno.test("renderWorkerTokenRevoke: log mode confirms revocation", () => {
  const data: WorkerTokenRevokeData = {
    name: "ci-runner-3",
    state: "revoked",
    revokedAt: "2026-06-09T12:00:00.000Z",
    alreadyRevoked: false,
  };
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerTokenRevoke(data, "log")),
  );
  assertStringIncludes(output, "Token ci-runner-3 revoked.");
  assertStringIncludes(output, "Revoked at: 2026-06-09T12:00:00.000Z");
});

Deno.test("renderWorkerTokenRevoke: log mode reports already-revoked", () => {
  const data: WorkerTokenRevokeData = {
    name: "old",
    state: "revoked",
    alreadyRevoked: true,
  };
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerTokenRevoke(data, "log")),
  );
  assertStringIncludes(output, "already revoked");
});

Deno.test("renderWorkerTokenRevoke: json mode emits the structured record", () => {
  const data: WorkerTokenRevokeData = {
    name: "ci-runner-3",
    state: "revoked",
    alreadyRevoked: false,
  };
  const output = captureLogs(() => renderWorkerTokenRevoke(data, "json"));
  const parsed = JSON.parse(output) as WorkerTokenRevokeData;
  assertEquals(parsed.name, "ci-runner-3");
  assertEquals(parsed.alreadyRevoked, false);
});

const workerListData: WorkerListData = {
  workers: [
    {
      name: "ci-runner-3",
      status: "busy",
      labels: { os: "linux", gpu: "none" },
      platform: "linux",
      arch: "x86_64",
      instanceUuid: "uuid-42",
      enrolledAt: "2026-06-09T00:00:00.000Z",
      lastSeenAt: "2026-06-09T12:00:00.000Z",
      currentDispatchId: "dispatch-7",
    },
    {
      name: "mac-builder",
      status: "idle",
      labels: {},
      platform: "darwin",
      arch: "aarch64",
      instanceUuid: "uuid-43",
      enrolledAt: "2026-06-09T00:00:00.000Z",
      lastSeenAt: "2026-06-09T11:00:00.000Z",
      currentDispatchId: null,
    },
  ],
  count: 2,
};

Deno.test("renderWorkerList: log mode renders the table", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerList(workerListData, "log")),
  );
  assertStringIncludes(output, "NAME");
  assertStringIncludes(output, "STATUS");
  assertStringIncludes(output, "LABELS");
  assertStringIncludes(output, "PLATFORM/ARCH");
  assertStringIncludes(output, "LAST SEEN");
  assertStringIncludes(output, "ci-runner-3");
  assertStringIncludes(output, "busy");
  assertStringIncludes(output, "os=linux,gpu=none");
  assertStringIncludes(output, "linux/x86_64");
  assertStringIncludes(output, "darwin/aarch64");
  assertStringIncludes(output, "2026-06-09T12:00:00.000Z");
});

Deno.test("renderWorkerList: log mode shows dash for empty labels", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerList(workerListData, "log")),
  );
  const macLine = output
    .split("\n")
    .find((line) => line.includes("mac-builder"));
  assertEquals(macLine !== undefined, true);
  assertStringIncludes(macLine!, "-");
});

Deno.test("renderWorkerList: log mode shows empty-state hint", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerList({ workers: [], count: 0 }, "log")),
  );
  assertStringIncludes(output, "No workers found.");
});

Deno.test("renderWorkerList: json mode emits the array of records", () => {
  const output = captureLogs(() => renderWorkerList(workerListData, "json"));
  const parsed = JSON.parse(output) as WorkerListData["workers"];
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].status, "busy");
  assertEquals(parsed[0].labels, { os: "linux", gpu: "none" });
  assertEquals(parsed[1].currentDispatchId, null);
});

Deno.test("renderWorkerStatus: dispatch lifecycle renders start and finish", () => {
  const joined = stripAnsiCode(captureLogs(() => {
    renderWorkerStatus(
      {
        kind: "dispatch_started",
        dispatchId: "abcdef12-3456",
        modelType: "command/shell",
        methodName: "execute",
        workflowName: "deploy",
        stepName: "build",
      },
      "log",
    );
    renderWorkerStatus(
      {
        kind: "dispatch_finished",
        dispatchId: "abcdef12-3456",
        modelType: "command/shell",
        methodName: "execute",
        status: "success",
        durationMs: 123.4,
      },
      "log",
    );
    renderWorkerStatus(
      {
        kind: "dispatch_finished",
        dispatchId: "abcdef12-3456",
        modelType: "command/shell",
        methodName: "execute",
        status: "error",
        durationMs: 50,
        error: "boom",
      },
      "log",
    );
  }));
  assertStringIncludes(joined, "abcdef12");
  assertStringIncludes(joined, "command/shell.execute");
  assertStringIncludes(joined, "deploy › build");
  assertStringIncludes(joined, "succeeded in 123ms");
  assertStringIncludes(joined, "boom");
});

Deno.test("renderWorkerStatus: dispatch events serialize whole in json mode", () => {
  const output = captureLogs(() => {
    renderWorkerStatus(
      {
        kind: "dispatch_started",
        dispatchId: "d-1",
        modelType: "m",
        methodName: "run",
      },
      "json",
    );
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.kind, "dispatch_started");
  assertEquals(parsed.dispatchId, "d-1");
});

// ── renderWorkerQueue ──────────────────────────────────────────────

const queueData: WorkerQueueListData = {
  items: [
    {
      queueId: "q-1",
      requirement: "tier=smoke, platform=linux",
      workflowName: "deploy",
      jobName: "main",
      stepName: "build",
      modelType: "@acme/widget",
      methodName: "create",
      queuedAt: "2026-07-04T00:00:00.000Z",
      ageMs: 65_000,
    },
    {
      queueId: "q-2",
      requirement: "any worker",
      workflowName: undefined,
      jobName: undefined,
      stepName: undefined,
      modelType: "command/shell",
      methodName: "execute",
      queuedAt: "2026-07-04T00:01:00.000Z",
      ageMs: 5_000,
    },
  ],
  count: 2,
};

Deno.test("renderWorkerQueue: log mode renders the table with columns", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerQueue(queueData, "log")),
  );
  assertStringIncludes(output, "REQUIREMENT");
  assertStringIncludes(output, "STEP");
  assertStringIncludes(output, "MODEL");
  assertStringIncludes(output, "QUEUED AT");
  assertStringIncludes(output, "AGE");
  assertStringIncludes(output, "tier=smoke, platform=linux");
  assertStringIncludes(output, "build");
  assertStringIncludes(output, "@acme/widget");
  assertStringIncludes(output, "any worker");
  assertStringIncludes(output, "command/shell.execute");
});

Deno.test("renderWorkerQueue: log mode shows empty-state message", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerQueue({ items: [], count: 0 }, "log")),
  );
  assertStringIncludes(output, "No steps are currently queued.");
});

Deno.test("renderWorkerQueue: json mode emits the array of items", () => {
  const output = captureLogs(() => renderWorkerQueue(queueData, "json"));
  const parsed = JSON.parse(output) as WorkerQueueListData["items"];
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].queueId, "q-1");
  assertEquals(parsed[0].requirement, "tier=smoke, platform=linux");
  assertEquals(parsed[1].stepName, undefined);
  assertEquals(parsed[1].modelType, "command/shell");
});

Deno.test("renderWorkerQueue: json mode emits empty array for no items", () => {
  const output = captureLogs(() =>
    renderWorkerQueue({ items: [], count: 0 }, "json")
  );
  const parsed = JSON.parse(output);
  assertEquals(parsed, []);
});

Deno.test("renderWorkerQueue: step column falls back to modelType.methodName when stepName is undefined", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerQueue(queueData, "log")),
  );
  assertStringIncludes(output, "command/shell.execute");
});

// ── renderWorkerVerify ────────────────────────────────────────────────

const verifyDataAllPass: WorkerVerifyData = {
  workers: [
    {
      name: "w1",
      status: "pass",
      platform: "linux",
      arch: "x86_64",
      probeMarkerOk: true,
      queryOk: true,
      dataPlaneOk: true,
      failures: [],
    },
  ],
  total: 1,
  passed: 1,
  failed: 0,
};

const verifyDataMixed: WorkerVerifyData = {
  workers: [
    {
      name: "w1",
      status: "pass",
      platform: "linux",
      arch: "x86_64",
      probeMarkerOk: true,
      queryOk: true,
      dataPlaneOk: true,
      failures: [],
    },
    {
      name: "w2",
      status: "fail",
      platform: "linux",
      arch: "aarch64",
      probeMarkerOk: true,
      queryOk: false,
      dataPlaneOk: false,
      failures: ["queryData: capability RPC channel failed"],
    },
  ],
  total: 2,
  passed: 1,
  failed: 1,
};

Deno.test("renderWorkerVerify: json mode emits structured data", () => {
  const output = captureLogs(() =>
    renderWorkerVerify(verifyDataAllPass, "json")
  );
  const parsed = JSON.parse(output);
  assertEquals(parsed.total, 1);
  assertEquals(parsed.passed, 1);
  assertEquals(parsed.workers[0].name, "w1");
  assertEquals(parsed.workers[0].status, "pass");
});

Deno.test("renderWorkerVerify: log mode shows worker names and status", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerVerify(verifyDataAllPass, "log")),
  );
  assertStringIncludes(output, "w1");
  assertStringIncludes(output, "pass");
  assertStringIncludes(output, "All 1 worker(s) passed");
});

Deno.test("renderWorkerVerify: log mode shows failure details", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderWorkerVerify(verifyDataMixed, "log")),
  );
  assertStringIncludes(output, "w2");
  assertStringIncludes(output, "fail");
  assertStringIncludes(output, "queryData: capability RPC channel failed");
  assertStringIncludes(output, "1 of 2 worker(s) failed");
});

Deno.test("renderWorkerVerify: log mode handles empty workers", () => {
  const output = stripAnsiCode(
    captureLogs(() =>
      renderWorkerVerify(
        { workers: [], total: 0, passed: 0, failed: 0 },
        "log",
      )
    ),
  );
  assertStringIncludes(output, "No connected workers");
});
