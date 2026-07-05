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
import { dirname, fromFileUrl, join } from "@std/path";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

import "../domain/models/models.ts";

await initializeLogging({});

const MODULE_DIR = dirname(fromFileUrl(import.meta.url));
const ENTRY_POINT = join(
  MODULE_DIR,
  "..",
  "cli",
  "commands",
  "worker_exec_dispatch_entry.ts",
);

const HEADER_SIZE = 4;

function makeFrame(data: string): Uint8Array {
  const encoder = new TextEncoder();
  const payload = encoder.encode(data);
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

function readFrame(buffer: Uint8Array): string | null {
  if (buffer.byteLength < HEADER_SIZE) return null;
  const payloadLen = new DataView(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + HEADER_SIZE),
  ).getUint32(0);
  if (buffer.byteLength < HEADER_SIZE + payloadLen) return null;
  return new TextDecoder().decode(
    buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen),
  );
}

interface RunnerResult {
  type: string;
  result: {
    status: string;
    error?: string;
    outputs: unknown[];
    logs: string[];
    durationMs: number;
  };
}

async function runRunner(bootstrapParams: unknown): Promise<RunnerResult> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      "--allow-sys",
      ENTRY_POINT,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(makeFrame(JSON.stringify(bootstrapParams)));
  await writer.close();

  const output = await child.output();
  const stdout = output.stdout;

  const frame = readFrame(new Uint8Array(stdout));
  if (!frame) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`Runner produced no result frame. stderr: ${stderr}`);
  }
  return JSON.parse(frame) as RunnerResult;
}

function validBootstrap(overrides?: {
  methodName?: string;
  bundleFingerprint?: string;
}) {
  return {
    sessionCredential: "cred-test",
    dataPlaneUrl: "http://localhost:0",
    cacheDirPath: "/tmp/runner-test-cache",
    dispatch: {
      dispatchId: "d-test-1",
      leaseId: "l-test-1",
      execution: {
        protocolVersion: 3,
        modelType: "swamp/fleet-probe",
        modelId: "probe-1",
        methodName: overrides?.methodName ?? "probe",
        globalArgs: {},
        methodArgs: {},
        definitionMeta: {
          id: "def-1",
          name: "test-probe",
          version: 1,
          tags: {},
        },
      },
      bundleFingerprint: overrides?.bundleFingerprint ??
        "builtin:swamp/fleet-probe",
      environmentSnapshot: {},
    },
  };
}

Deno.test("exec_dispatch: method not found surfaces as error result", async () => {
  const result = await runRunner(
    validBootstrap({ methodName: "nonexistent" }),
  );

  assertEquals(result.type, "runner.result");
  assertEquals(result.result.status, "error");
  assertStringIncludes(
    result.result.error!,
    "Method 'nonexistent' not found",
  );
});

Deno.test("exec_dispatch: unknown bundle fingerprint surfaces as error result", async () => {
  const result = await runRunner(
    validBootstrap({ bundleFingerprint: "sha256:unknown-bundle-abc" }),
  );

  assertEquals(result.type, "runner.result");
  assertEquals(result.result.status, "error");
});
