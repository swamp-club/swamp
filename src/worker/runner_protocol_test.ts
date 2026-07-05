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

import { assertEquals, assertThrows } from "@std/assert";
import { RunnerBootstrapParamsSchema } from "./runner_protocol.ts";
import { ZodError } from "zod";

function validBootstrapParams(): Record<string, unknown> {
  return {
    sessionCredential: "cred-abc-123",
    dataPlaneUrl: "https://orchestrator.example.com",
    cacheDirPath: "/tmp/swamp-cache",
    dispatch: {
      dispatchId: "dispatch-001",
      leaseId: "lease-001",
      execution: {
        protocolVersion: 3,
        modelType: "@test/model",
        modelId: "model-abc",
        methodName: "run",
        globalArgs: {},
        methodArgs: { input: "hello" },
        definitionMeta: {
          id: "def-001",
          name: "test-model",
          version: 1,
          tags: {},
        },
      },
      bundleFingerprint: "sha256:abc123",
      environmentSnapshot: { API_KEY: "secret" },
    },
  };
}

Deno.test("RunnerBootstrapParamsSchema: parses valid params", () => {
  const params = RunnerBootstrapParamsSchema.parse(validBootstrapParams());
  assertEquals(params.sessionCredential, "cred-abc-123");
  assertEquals(params.dataPlaneUrl, "https://orchestrator.example.com");
  assertEquals(params.cacheDirPath, "/tmp/swamp-cache");
  assertEquals(params.dispatch.dispatchId, "dispatch-001");
  assertEquals(params.dispatch.execution.methodName, "run");
});

Deno.test("RunnerBootstrapParamsSchema: rejects missing credential", () => {
  const params = validBootstrapParams();
  delete params.sessionCredential;
  assertThrows(() => RunnerBootstrapParamsSchema.parse(params), ZodError);
});

Deno.test("RunnerBootstrapParamsSchema: rejects empty credential", () => {
  const params = validBootstrapParams();
  params.sessionCredential = "";
  assertThrows(() => RunnerBootstrapParamsSchema.parse(params), ZodError);
});

Deno.test("RunnerBootstrapParamsSchema: rejects missing dispatch", () => {
  const params = validBootstrapParams();
  delete params.dispatch;
  assertThrows(() => RunnerBootstrapParamsSchema.parse(params), ZodError);
});

Deno.test("RunnerBootstrapParamsSchema: defaults reportBundleFingerprints to empty", () => {
  const params = RunnerBootstrapParamsSchema.parse(validBootstrapParams());
  assertEquals(params.dispatch.reportBundleFingerprints, []);
});
