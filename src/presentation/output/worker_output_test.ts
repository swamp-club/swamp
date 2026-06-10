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
  WorkerTokenCreateData,
  WorkerTokenListData,
  WorkerTokenRevokeData,
} from "../../libswamp/mod.ts";
import {
  renderWorkerList,
  renderWorkerStatus,
  renderWorkerTokenCreate,
  renderWorkerTokenList,
  renderWorkerTokenRevoke,
} from "./worker_output.ts";

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
      boundInstanceUuid: "uuid-42",
      vaultName: "main-vault",
      secretKey: "worker-token-ci-runner-3",
    },
    {
      name: "stale",
      state: "unused",
      effectiveState: "expired",
      createdAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-06-02T00:00:00.000Z",
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
  assertStringIncludes(output, "BOUND INSTANCE");
  assertStringIncludes(output, "ci-runner-3");
  assertStringIncludes(output, "enrolled");
  assertStringIncludes(output, "uuid-42");
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
