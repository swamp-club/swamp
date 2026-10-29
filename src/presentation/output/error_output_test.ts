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
import {
  COMMIT_PARTLY_COMMITTED_CODE,
  CommitUnreachableError,
  PartitionsRefusedError,
  RUN_PARTLY_COMMITTED_CODE,
  RunPartlyCommittedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { ValidationError } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  buildErrorJson,
  exitCodeForError,
  platformCertStoreHint,
  renderError,
  tlsErrorHint,
} from "./error_output.ts";
import { UserError } from "../../domain/errors.ts";
import {
  markModelWording,
  wordedError,
  wordedText,
  wordedUserError,
} from "../../domain/behavior_wording.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import {
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "../../domain/datastore_v3/litestream_replication.ts";
import { AuthGateBlockedError } from "../../domain/auth/auth_gate_blocked_error.ts";
import {
  LockTimeoutError,
  LockWaitCycleError,
} from "../../domain/datastore/distributed_lock.ts";
import { DuplicateTypeUserError } from "../../domain/extensions/duplicate_type_user_error.ts";
import { SignalRefusedUserError } from "../../domain/workflows/signal_refused_user_error.ts";
import {
  InvalidDatastoreFormatMarkerError,
  UnsupportedDatastoreFormatError,
} from "../../domain/datastore/datastore_format.ts";
import {
  V3StorageUnreachableError,
  WriterFencedError,
} from "../../domain/datastore_v3/writer_lease.ts";
import {
  ReadModelApplyError,
  ReadModelCatchUpUnreachableError,
} from "../../domain/datastore_v3/read_model.ts";
import { V3WriterBusyError } from "../../infrastructure/datastore_v3/v3_writer_lock.ts";
import { ServeUnreachableError } from "../../infrastructure/datastore_v3/serve_upstream_errors.ts";
import { ReadModelBusyError } from "../../domain/datastore_v3/read_model.ts";
import { ServeNotLeaderError } from "../../domain/datastore_v3/serve_leader.ts";
import {
  flushAuthGateWarning,
  renderAuthGateWarning,
  takeAuthGateWarning,
} from "../renderers/auth_gate_warning.ts";

await initializeLogging({});

Deno.test("renderError logs UserError message directly to stderr without LogTape formatting", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    const error = new UserError("Model not found");
    renderError(error);

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Error:");
    assertStringIncludes(logs[0], "Model not found");
    // Should not contain stack trace lines
    assertEquals(logs[0].includes("    at "), false);
    // Should not contain LogTape formatting (level prefix, category)
    assertEquals(logs[0].includes("FTL"), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError logs non-UserError with error object", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    const error = new Error("Something broke");
    renderError(error);

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Something broke");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError wraps non-Error values in Error", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError("plain string error");

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "plain string error");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError logs Cliffy ValidationError missing argument without stack trace", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    const error = new ValidationError("Missing argument(s): extension");
    renderError(error);

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Missing argument(s): extension");
    // Should not contain stack trace lines
    assertEquals(logs[0].includes("    at "), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError suppresses Cliffy Command dump on ValidationError (issue #171)", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    const error = new ValidationError(
      'Unknown option "--inputs". Did you mean option "--input"?',
    );
    // Mimic Cliffy's real failure: ValidationError carries a `cmd` payload
    // that points at the parsed Command tree (with circular refs).
    const fakeCmd: Record<string, unknown> = {
      settings: { name: "swamp", description: "AI Native Automation CLI" },
    };
    fakeCmd.cmd = fakeCmd;
    Object.assign(error, { cmd: fakeCmd, exitCode: 2 });

    renderError(error);

    assertEquals(logs.length, 1);
    assertStringIncludes(
      logs[0],
      'Unknown option "--inputs". Did you mean option "--input"?',
    );
    // The bug was a 300-line dump of Cliffy internals — none of these markers
    // should leak into user-facing output.
    assertEquals(logs[0].includes("Command {"), false);
    assertEquals(logs[0].includes("settings:"), false);
    assertEquals(logs[0].includes("[Circular"), false);
    assertEquals(logs[0].includes("    at "), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError: json mode emits clean JSON for ValidationError (issue #171)", () => {
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    const error = new ValidationError(
      'Unknown option "--inputs". Did you mean option "--input"?',
    );
    const fakeCmd: Record<string, unknown> = { settings: { name: "swamp" } };
    fakeCmd.cmd = fakeCmd;
    Object.assign(error, { cmd: fakeCmd, exitCode: 2 });

    renderError(error, "json");

    assertEquals(stderrLogs.length, 1);
    const parsed = JSON.parse(stderrLogs[0]);
    assertEquals(
      parsed.error,
      'Unknown option "--inputs". Did you mean option "--input"?',
    );
    // ValidationError should never produce a stack in JSON output.
    assertEquals(parsed.stack, undefined);
    // And the raw payload must not leak.
    assertEquals(stderrLogs[0].includes("Command {"), false);
    assertEquals(stderrLogs[0].includes("[Circular"), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("renderError: UserError goes to console.error directly, system errors go through LogTape", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError(new UserError("user error"));
    renderError(new Error("system error"));

    // Both should have logged (UserError direct, system via LogTape fatal)
    assertEquals(logs.length, 2);
    // UserError: direct console.error, no LogTape formatting
    assertStringIncludes(logs[0], "user error");
    assertEquals(logs[0].includes("FTL"), false);
  } finally {
    console.error = originalError;
  }
});

// ============================================================================
// JSON stdout output tests
// ============================================================================

Deno.test("renderError: json mode is single-emitter (stderr JSON, no stdout)", () => {
  const stdoutLogs: string[] = [];
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdoutLogs.push(args.join(" "));
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    renderError(new UserError("Model not found"), "json");

    assertEquals(stderrLogs.length, 1);
    const parsed = JSON.parse(stderrLogs[0]);
    assertEquals(parsed.error, "Model not found");
    assertEquals(parsed.stack, undefined);
    // Single-emission contract: in JSON mode renderError writes to
    // stderr only — stdout stays clean for success data.
    assertEquals(stdoutLogs.length, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("renderError: json mode carries a held offline warning on the one error document (swamp-club#2938)", () => {
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    renderAuthGateWarning("json", "Running offline", () => {});
    renderError(new UserError("Model not found"), "json");
    // The exit hook runs after the error and must add nothing.
    flushAuthGateWarning();

    assertEquals(stderrLogs.length, 1);
    assertEquals(JSON.parse(stderrLogs[0]), {
      error: "Model not found",
      warning: "Running offline",
      authMode: "offline",
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    takeAuthGateWarning();
  }
});

Deno.test("renderError: json mode without a held warning adds no warning fields", () => {
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    renderError(new UserError("Model not found"), "json");
    assertEquals(JSON.parse(stderrLogs[0]), { error: "Model not found" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("renderError: json mode surfaces UserError code field", () => {
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    renderError(new UserError("Operation timed out", "timeout"), "json");
    assertEquals(stderrLogs.length, 1);
    const parsed = JSON.parse(stderrLogs[0]);
    assertEquals(parsed.error, "Operation timed out");
    assertEquals(parsed.code, "timeout");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("renderError: json mode surfaces a `code` property from any error", () => {
  // Errors thrown from libswamp paths often carry a `code` via duck typing
  // rather than via UserError (e.g. cancellations, validation failures).
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    const error = new Error("Operation was cancelled.");
    Object.assign(error, { code: "cancelled" });
    renderError(error, "json");
    assertEquals(stderrLogs.length, 1);
    const parsed = JSON.parse(stderrLogs[0]);
    assertEquals(parsed.code, "cancelled");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("renderError: log mode does not write to stdout", () => {
  const stdoutLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdoutLogs.push(args.join(" "));
  console.error = () => {};

  try {
    renderError(new UserError("Model not found"), "log");

    assertEquals(stdoutLogs.length, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

Deno.test("renderError: no outputMode does not write to stdout", () => {
  const stdoutLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdoutLogs.push(args.join(" "));
  console.error = () => {};

  try {
    renderError(new UserError("Model not found"));

    assertEquals(stdoutLogs.length, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

// ============================================================================
// buildErrorJson tests
// ============================================================================

/** A refused stale edit of workflow `deploy`, as a root unit throws it. */
function staleEdit(): PartitionsRefusedError {
  return new PartitionsRefusedError([{
    partition: partitionOf({
      kind: "config",
      definitionKind: "workflow",
      name: "deploy",
    }),
    reason: "expect-failed",
    message: "Record config/workflows/workflow-deploy.yaml is not sha256 aa",
    key: "config/workflows/workflow-deploy.yaml",
    changedBy: "alice",
    changedAt: "2026-10-29T10:00:00.000Z",
    versions: [],
  }], []);
}

Deno.test("renderError: a refused stale config edit is one plain error line naming the change, not a crash (swamp-club#4097)", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    renderError(staleEdit());
    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], "Workflow 'deploy' was changed by alice");
    assertEquals(logs[0].includes("    at "), false);
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError: a refused stale config edit in json mode has its code and conflicts (swamp-club#4097)", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    renderError(staleEdit(), "json");
    const json = JSON.parse(logs[0]);
    assertEquals(json.code, "config_edit_conflict");
    assertEquals(json.stack, undefined);
    assertEquals(json.conflicts, [{
      kind: "workflow",
      name: "deploy",
      key: "config/workflows/workflow-deploy.yaml",
      changedBy: "alice",
      changedAt: "2026-10-29T10:00:00.000Z",
    }]);
  } finally {
    console.error = originalError;
  }
});

Deno.test("buildErrorJson: UserError produces error-only JSON", () => {
  const result = buildErrorJson(new UserError("Not found"));
  assertEquals(result.error, "Not found");
  assertEquals(result.stack, undefined);
});

Deno.test("buildErrorJson: system Error includes stack", () => {
  const result = buildErrorJson(new Error("Something broke"));
  assertEquals(result.error, "Something broke");
  assertEquals(typeof result.stack, "string");
  assertStringIncludes(result.stack as string, "at ");
});

Deno.test("buildErrorJson: Cliffy ValidationError has no stack", () => {
  const result = buildErrorJson(
    new ValidationError("Missing argument(s): extension"),
  );
  assertEquals(result.error, "Missing argument(s): extension");
  assertEquals(result.stack, undefined);
});

Deno.test("buildErrorJson: surfaces UserError code", () => {
  const result = buildErrorJson(new UserError("timed out", "timeout"));
  assertEquals(result.code, "timeout");
});

Deno.test("buildErrorJson: surfaces a `code` property from any error", () => {
  const error = new Error("cancelled by user");
  Object.assign(error, { code: "cancelled" });
  const result = buildErrorJson(error);
  assertEquals(result.code, "cancelled");
});

Deno.test("buildErrorJson: omits code field when not present", () => {
  const result = buildErrorJson(new UserError("plain"));
  assertEquals(result.code, undefined);
});

// =============================================================
// Plan v4 step 11 — DuplicateTypeUserError JSON shape
// =============================================================
//
// Pinned shape: log mode emits a single-line message; JSON mode emits
// the same message PLUS a structured `duplicateType` object so jq /
// AI agents / CI scripts can read the collision details without
// re-parsing the message. This test pins both the structural shape
// and the parity (same fields available across modes).

Deno.test(
  "buildErrorJson: DuplicateTypeUserError emits structured duplicateType field (W2 plan v4 step 11)",
  () => {
    const err = new DuplicateTypeUserError({
      kind: "model",
      typeNormalized: "@scope/foo",
      existing: {
        extensionName: "@scopeA/aa",
        extensionVersion: "1.0.0",
        canonicalPath:
          "/repo/.swamp/pulled-extensions/@scopeA/aa/models/foo.ts",
      },
      conflicting: {
        extensionName: "@scopeB/bb",
        extensionVersion: "1.0.0",
        canonicalPath:
          "/repo/.swamp/pulled-extensions/@scopeB/bb/models/foo.ts",
      },
    });

    const result = buildErrorJson(err);

    // Default UserError treatment: message present, no stack trace.
    assertStringIncludes(
      result.error as string,
      `Type "@scope/foo" (kind=model)`,
    );
    assertStringIncludes(
      result.error as string,
      "@scopeA/aa@1.0.0",
    );
    assertStringIncludes(
      result.error as string,
      "@scopeB/bb@1.0.0",
    );
    assertEquals(result.stack, undefined);

    // Structured field — pinned shape.
    const dup = result.duplicateType as Record<string, unknown>;
    assertEquals(dup.kind, "model");
    assertEquals(dup.type, "@scope/foo");
    assertEquals(dup.isGhostRow, false);
    // Rollback outcome defaults to rolled-back.
    assertEquals(dup.rolledBack, true);
    assertEquals(dup.rollback, { status: "rolled-back" });
    const existing = dup.existing as Record<string, string>;
    assertEquals(existing.extensionName, "@scopeA/aa");
    assertEquals(existing.extensionVersion, "1.0.0");
    assertEquals(
      existing.canonicalPath,
      "/repo/.swamp/pulled-extensions/@scopeA/aa/models/foo.ts",
    );
    const conflicting = dup.conflicting as Record<string, string>;
    assertEquals(conflicting.extensionName, "@scopeB/bb");
    assertEquals(conflicting.extensionVersion, "1.0.0");
    assertEquals(
      conflicting.canonicalPath,
      "/repo/.swamp/pulled-extensions/@scopeB/bb/models/foo.ts",
    );
  },
);

Deno.test(
  "buildErrorJson: DuplicateTypeUserError log+JSON share the same structured fields (output parity)",
  () => {
    const err = new DuplicateTypeUserError({
      kind: "vault",
      typeNormalized: "@scope/parity",
      existing: {
        extensionName: "@scopeA/aa",
        extensionVersion: "1.0.0",
        canonicalPath: "/path/a.ts",
      },
      conflicting: {
        extensionName: "@scopeB/bb",
        extensionVersion: "2.0.0",
        canonicalPath: "/path/b.ts",
      },
    });

    // Log mode: the message line names both extensions and the
    // colliding type — no need for a separate test since the
    // top-level renderer logs `err.message` verbatim.
    assertStringIncludes(err.message, "@scopeA/aa@1.0.0");
    assertStringIncludes(err.message, "@scopeB/bb@2.0.0");
    assertStringIncludes(err.message, "@scope/parity");
    assertStringIncludes(err.message, "(kind=vault)");

    // JSON mode: same fields available structurally.
    const result = buildErrorJson(err);
    const dup = result.duplicateType as Record<string, unknown>;
    assertEquals(dup.kind, "vault");
    assertEquals(dup.type, "@scope/parity");
    assertEquals(
      (dup.existing as Record<string, string>).extensionName,
      "@scopeA/aa",
    );
    assertEquals(
      (dup.conflicting as Record<string, string>).extensionVersion,
      "2.0.0",
    );
  },
);

Deno.test(
  "buildErrorJson: DuplicateTypeUserError carries an explicit rolled-back outcome",
  () => {
    const err = new DuplicateTypeUserError({
      kind: "model",
      typeNormalized: "@scope/rb",
      existing: {
        extensionName: "@scopeA/aa",
        extensionVersion: "1.0.0",
        canonicalPath: "/path/a.ts",
      },
      conflicting: {
        extensionName: "@scopeB/bb",
        extensionVersion: "2.0.0",
        canonicalPath: "/path/b.ts",
      },
      rollback: { status: "rolled-back" },
    });

    const result = buildErrorJson(err);
    assertStringIncludes(result.error as string, "rolled back");
    const dup = result.duplicateType as Record<string, unknown>;
    assertEquals(dup.rolledBack, true);
    assertEquals(dup.rollback, { status: "rolled-back" });
  },
);

Deno.test(
  "buildErrorJson: DuplicateTypeUserError carries a kept outcome with rolledBack false",
  () => {
    const kept = [
      { name: "@scopeB/bb", version: "2.0.0", priorVersion: "1.0.0" },
      { name: "@scopeB/dep", version: "1.0.0", priorVersion: null },
    ];
    const err = new DuplicateTypeUserError({
      kind: "model",
      typeNormalized: "@scope/kept",
      existing: {
        extensionName: "@scopeA/aa",
        extensionVersion: "1.0.0",
        canonicalPath: "/path/a.ts",
      },
      conflicting: {
        extensionName: "@scopeB/bb",
        extensionVersion: "2.0.0",
        canonicalPath: "/path/b.ts",
      },
      rollback: { status: "kept", kept },
    });

    const result = buildErrorJson(err);
    assertEquals(result.error, err.message);
    assertEquals(result.stack, undefined);
    const dup = result.duplicateType as Record<string, unknown>;
    assertEquals(dup.type, "@scope/kept");
    assertEquals(dup.isGhostRow, false);
    assertEquals(dup.rolledBack, false);
    assertEquals(dup.rollback, { status: "kept", kept });
    // The whole object survives JSON serialization (priorVersion: null
    // included), since the JSON renderer stringifies it.
    assertEquals(
      JSON.parse(JSON.stringify(result)).duplicateType.rollback,
      { status: "kept", kept },
    );
  },
);

Deno.test(
  "buildErrorJson: DuplicateTypeUserError carries an unsettled outcome with its lockfile path",
  () => {
    const lockfilePath = "/repo/extensions/models/upstream_extensions.json";
    const err = new DuplicateTypeUserError({
      kind: "vault",
      typeNormalized: "@scope/unsettled",
      existing: {
        extensionName: "@scopeA/aa",
        extensionVersion: "1.0.0",
        canonicalPath: "/path/a.ts",
      },
      conflicting: {
        extensionName: "@scopeB/bb",
        extensionVersion: "2.0.0",
        canonicalPath: "/path/b.ts",
      },
      isGhostRow: true,
      rollback: { status: "unsettled", lockfilePath },
    });

    const result = buildErrorJson(err);
    assertStringIncludes(
      result.error as string,
      "The rollback could not finish",
    );
    const dup = result.duplicateType as Record<string, unknown>;
    assertEquals(dup.kind, "vault");
    assertEquals(dup.isGhostRow, true);
    assertEquals(dup.rolledBack, false);
    assertEquals(dup.rollback, { status: "unsettled", lockfilePath });
  },
);

// ============================================================================
// exitCodeForError tests
// ============================================================================

Deno.test("exitCodeForError: returns 75 for a write a serve follower refused (swamp-club#4096)", () => {
  assertEquals(exitCodeForError(new ServeNotLeaderError(undefined)), 75);
});

Deno.test("exitCodeForError: returns 75 for LockTimeoutError", () => {
  const err = new LockTimeoutError("/path/.lock", null, 60000);
  assertEquals(exitCodeForError(err), 75);
});

Deno.test("exitCodeForError: returns 75 for UserError with lock_timeout code", () => {
  const err = new UserError("timed out", "lock_timeout");
  assertEquals(exitCodeForError(err), 75);
});

Deno.test("exitCodeForError: returns 75 for an extension LOCK_TIMEOUT error", () => {
  const err = Object.assign(new Error("Lock timed out"), {
    code: "LOCK_TIMEOUT",
  });
  assertEquals(exitCodeForError(err), 75);
});

Deno.test("exitCodeForError: returns 75 for commits a sync did not confirm, 1 for a refused sidecar", () => {
  const unconfirmed = new V3ReplicationError("the sync timed out");
  assertEquals(exitCodeForError(unconfirmed), 75);
  assertEquals(
    buildErrorJson(unconfirmed).code,
    "datastore_v3_replication_unconfirmed",
  );
  assertEquals(
    exitCodeForError(new V3ReplicationUnavailableError("busy")),
    1,
  );
});

Deno.test("exitCodeForError: returns 75 for v3 writer lease contention, 1 for a fenced writer (swamp-club#3564)", () => {
  const busy = new V3WriterBusyError(
    "/ds",
    new LockTimeoutError(
      "_control/writer",
      {
        holder: "u@h",
        hostname: "h",
        pid: 1,
        acquiredAt: new Date().toISOString(),
        ttlMs: 30_000,
      },
      0,
    ),
  );
  assertEquals(exitCodeForError(busy), 75);
  assertEquals(buildErrorJson(busy).code, "datastore_v3_writer_busy");
  assertEquals(exitCodeForError(new WriterFencedError(1, 2)), 1);
});

Deno.test("exitCodeForError: returns 75 when the serve a v3 datastore is written through is unreachable (swamp-club#3985)", () => {
  for (const sent of ["never", "maybe"] as const) {
    const err = new ServeUnreachableError(
      "https://serve.example.com",
      sent,
      new TypeError("fetch failed"),
    );
    assertEquals(exitCodeForError(err), 75);
    assertEquals(buildErrorJson(err).code, "datastore_v3_serve_unreachable");
  }
});

Deno.test("buildErrorJson: reports an extension LOCK_TIMEOUT code as lock_timeout", () => {
  const err = Object.assign(new Error("Lock timed out"), {
    code: "LOCK_TIMEOUT",
  });
  assertEquals(buildErrorJson(err).code, "lock_timeout");
});

Deno.test("exitCodeForError: returns 1 for LockWaitCycleError, which a retry cannot clear", () => {
  const err = new LockWaitCycleError({
    opponentPid: 4242,
    waitedMs: 2000,
    waitingOnLockPaths: ["data/mytype/my-model/.lock"],
  });
  assertEquals(exitCodeForError(err), 1);
  assertEquals(buildErrorJson(err).code, "lock_wait_cycle");
  assertEquals(buildErrorJson(err).stack, undefined);
});

Deno.test("exitCodeForError: returns 1 for UserError without code", () => {
  const err = new UserError("something broke");
  assertEquals(exitCodeForError(err), 1);
});

Deno.test("exitCodeForError: returns 1 for UserError with other code", () => {
  const err = new UserError("not found", "model_not_found");
  assertEquals(exitCodeForError(err), 1);
});

Deno.test("exitCodeForError: returns 1 for plain Error", () => {
  assertEquals(exitCodeForError(new Error("crash")), 1);
});

Deno.test("exitCodeForError: returns 1 for non-Error values", () => {
  assertEquals(exitCodeForError("string error"), 1);
  assertEquals(exitCodeForError(null), 1);
  assertEquals(exitCodeForError(undefined), 1);
});

Deno.test("buildErrorJson: LockTimeoutError includes code field", () => {
  const err = new LockTimeoutError("/path/.lock", null, 60000);
  const result = buildErrorJson(err);
  assertEquals(result.code, "lock_timeout");
  assertStringIncludes(result.error as string, "timed out after 60000ms");
});

// ============================================================================
// tlsErrorHint tests (issue #1518)
// ============================================================================

Deno.test("tlsErrorHint: returns hint for UnknownIssuer error", () => {
  const hint = tlsErrorHint(
    "error sending request for url (https://fw.example.com/api/): client error (Connect): invalid peer certificate: UnknownIssuer",
  );
  assertEquals(hint !== undefined, true);
  assertStringIncludes(hint!, "SSL_CERT_FILE");
  assertStringIncludes(hint!, "root CA");
});

Deno.test("tlsErrorHint: returns hint for invalid peer certificate error", () => {
  const hint = tlsErrorHint("invalid peer certificate: something");
  assertEquals(hint !== undefined, true);
  assertStringIncludes(hint!, "SSL_CERT_FILE");
});

Deno.test("tlsErrorHint: returns undefined for unrelated errors", () => {
  assertEquals(tlsErrorHint("connection refused"), undefined);
  assertEquals(tlsErrorHint("Model not found"), undefined);
  assertEquals(tlsErrorHint("timeout"), undefined);
});

Deno.test("renderError: log mode appends TLS hint for UnknownIssuer", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError(
      new UserError(
        "error sending request: invalid peer certificate: UnknownIssuer",
      ),
    );

    assertEquals(logs.length, 2);
    assertStringIncludes(logs[0], "UnknownIssuer");
    assertStringIncludes(logs[1], "Hint:");
    assertStringIncludes(logs[1], "SSL_CERT_FILE");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError: json mode includes hint field for UnknownIssuer", () => {
  const stderrLogs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    renderError(
      new UserError(
        "error sending request: invalid peer certificate: UnknownIssuer",
      ),
      "json",
    );

    assertEquals(stderrLogs.length, 1);
    const parsed = JSON.parse(stderrLogs[0]);
    assertStringIncludes(parsed.hint, "SSL_CERT_FILE");
    assertStringIncludes(parsed.hint, "root CA");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError: no TLS hint for non-TLS errors", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError(new UserError("Model not found"));
    assertEquals(logs.length, 1);
    assertEquals(logs[0].includes("Hint:"), false);
  } finally {
    console.error = originalError;
  }
});

// ============================================================================
// platformCertStoreHint tests (swamp-club#2314)
// ============================================================================

// Verbatim from Deno 2.9.7: a global fetch() when the OS store read fails.
const RAW_CERT_STORE_MESSAGE =
  "Failed to load platform certificates: No such file or directory (os error 2)";

function certStoreErrorWithStack(): Error {
  const error = new Error(RAW_CERT_STORE_MESSAGE);
  error.stack = `Error: ${RAW_CERT_STORE_MESSAGE}\n` +
    "    at mainFetch (ext:deno_fetch/26_fetch.js:2:2193)\n" +
    "    at HttpUpdateChecker.checkForUpdate (file:///src/infrastructure/update/http_update_checker.ts:248:28)";
  return error;
}

Deno.test("platformCertStoreHint: returns remedy for the raw Deno message", () => {
  const hint = platformCertStoreHint(RAW_CERT_STORE_MESSAGE);
  assertEquals(hint !== undefined, true);
  assertStringIncludes(hint!, "DENO_TLS_CA_STORE=mozilla");
  assertStringIncludes(hint!, "SSL_CERT_FILE");
  assertStringIncludes(hint!, "corporate CA");
});

Deno.test("platformCertStoreHint: returns remedy for the macOS keychain variant", () => {
  const hint = platformCertStoreHint(
    "Failed to load platform certificates: SecTrustSettingsCopyCertificates failed",
  );
  assertStringIncludes(hint!, "DENO_TLS_CA_STORE=mozilla");
});

Deno.test("platformCertStoreHint: returns remedy when embedded in a wrapping message", () => {
  for (
    const message of [
      `Could not connect to https://swamp-club.com: ${RAW_CERT_STORE_MESSAGE}`,
      `Download failed: ${RAW_CERT_STORE_MESSAGE}`,
    ]
  ) {
    assertStringIncludes(
      platformCertStoreHint(message)!,
      "DENO_TLS_CA_STORE=mozilla",
    );
  }
});

Deno.test("platformCertStoreHint: returns undefined for unrelated and UnknownIssuer errors", () => {
  assertEquals(platformCertStoreHint("connection refused"), undefined);
  assertEquals(
    platformCertStoreHint("invalid peer certificate: UnknownIssuer"),
    undefined,
  );
});

Deno.test("platformCertStoreHint: returns undefined when the message already names the remedy", () => {
  assertEquals(
    platformCertStoreHint(
      `Could not read the OS certificate store: ${RAW_CERT_STORE_MESSAGE} — ` +
        "re-run with DENO_TLS_CA_STORE=mozilla",
    ),
    undefined,
  );
});

Deno.test("renderError: log mode renders a raw cert-store Error without a stack trace", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError(certStoreErrorWithStack());

    assertEquals(logs.length, 2);
    assertStringIncludes(logs[0], "Error:");
    assertStringIncludes(logs[0], RAW_CERT_STORE_MESSAGE);
    assertEquals(logs[0].includes("    at "), false);
    assertEquals(logs[0].includes("FTL"), false);
    assertStringIncludes(logs[1], "Hint:");
    assertStringIncludes(logs[1], "DENO_TLS_CA_STORE=mozilla");
    assertStringIncludes(logs[1], "SSL_CERT_FILE");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError: json mode renders a raw cert-store Error with a hint and no stack", () => {
  const stderrLogs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => stderrLogs.push(args.join(" "));

  try {
    renderError(certStoreErrorWithStack(), "json");

    assertEquals(stderrLogs.length, 1);
    const parsed = JSON.parse(stderrLogs[0]);
    assertEquals(parsed.error, RAW_CERT_STORE_MESSAGE);
    assertEquals(parsed.stack, undefined);
    assertStringIncludes(parsed.hint, "DENO_TLS_CA_STORE=mozilla");
  } finally {
    console.error = originalError;
  }
});

Deno.test("renderError: log mode appends the cert-store hint once to a wrapping UserError", () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderError(
      new UserError(
        `Could not connect to https://swamp-club.com: ${RAW_CERT_STORE_MESSAGE}`,
      ),
    );

    assertEquals(logs.length, 2);
    assertStringIncludes(logs[0], "Could not connect");
    assertEquals(logs[1].split("DENO_TLS_CA_STORE=mozilla").length, 2);
  } finally {
    console.error = originalError;
  }
});

Deno.test("buildErrorJson: an auth gate block reports its reason as data", () => {
  const json = buildErrorJson(
    new AuthGateBlockedError(
      { kind: "refused", status: 429, retryAfterSeconds: 30 },
      "Could not verify your identity",
    ),
  );
  assertEquals(json.code, "auth_gate_blocked");
  assertEquals(json.reason, {
    kind: "refused",
    status: 429,
    retryAfterSeconds: 30,
  });
  assertEquals(json.temporary, true);
});

Deno.test("exitCodeForError: temporary auth gate blocks exit 75, the rest 1", () => {
  for (
    const reason of [
      { kind: "refused", status: 403 } as const,
      { kind: "unreachable_unverified" } as const,
      { kind: "unverified_for_a_day" } as const,
    ]
  ) {
    assertEquals(exitCodeForError(new AuthGateBlockedError(reason, "x")), 75);
  }
  for (
    const reason of [
      { kind: "no_credential" } as const,
      { kind: "revoked" } as const,
    ]
  ) {
    assertEquals(exitCodeForError(new AuthGateBlockedError(reason, "x")), 1);
  }
});

Deno.test("datastore format errors: --json carries the stable code and no stack, exit 1, log mode prints the message alone", () => {
  for (
    const [error, code] of [
      [
        new UnsupportedDatastoreFormatError({ format: 3, writtenBy: "9.9" }, [
          2,
        ]),
        "datastore_format_unsupported",
      ],
      [
        new InvalidDatastoreFormatMarkerError(
          "_control/datastore-format",
          "not valid JSON",
        ),
        "datastore_format_marker_invalid",
      ],
    ] as const
  ) {
    assertEquals(buildErrorJson(error), { error: error.message, code });
    assertEquals(exitCodeForError(error), 1);

    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      renderError(error, "log");
      renderError(error, "json");
    } finally {
      console.error = originalError;
    }
    assertEquals(logs.length, 2);
    assertStringIncludes(logs[0], error.message);
    assertEquals(logs[0].includes("    at "), false);
    assertEquals(JSON.parse(logs[1]), { error: error.message, code });
  }
});

Deno.test("buildErrorJson: a refused signal carries the refusal, and the key's last wait when there is one", () => {
  const lastWait = {
    waitId: "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90",
    settledAs: "timed_out" as const,
    settledAt: "2026-01-01T00:00:30.000Z",
  };
  assertEquals(
    buildErrorJson(
      new SignalRefusedUserError(
        "No open wait holds that key.",
        "validation_failed",
        "no_open_wait",
        lastWait,
      ),
    ),
    {
      error: "No open wait holds that key.",
      code: "validation_failed",
      refusal: "no_open_wait",
      lastWait,
    },
  );
  assertEquals(
    buildErrorJson(
      new SignalRefusedUserError("expired", "validation_failed", "expired"),
    ),
    { error: "expired", code: "validation_failed", refusal: "expired" },
  );
});

/** Captures what `fn` writes with console.error. */
function captureStderr(fn: () => void): string {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = originalError;
  }
  return logs.join("\n");
}

Deno.test("renderError: a worded error prints the spelling of the command tree (swamp-club#3437)", () => {
  const error = wordedUserError(wordedText((w) => `${w.Noun} not found: x`));
  const underModel = captureStderr(() => renderError(error, "log", "model"));
  assertStringIncludes(underModel, "Model not found: x");
  const underBehavior = captureStderr(() =>
    renderError(error, "log", "behavior")
  );
  assertStringIncludes(underBehavior, "Behavior not found: x");
  // Outside both trees, the surface defaults to behavior.
  assertStringIncludes(
    captureStderr(() => renderError(error, "log")),
    "Behavior not found: x",
  );
});

Deno.test("buildErrorJson: the error text follows the surface and adds no fields", () => {
  const error = wordedUserError(
    wordedText((w) => `${w.Noun} not found: x`),
    "not_found",
  );
  assertEquals(buildErrorJson(error, "model"), {
    error: "Model not found: x",
    code: "not_found",
  });
  assertEquals(buildErrorJson(error, "behavior"), {
    error: "Behavior not found: x",
    code: "not_found",
  });
});

Deno.test("renderError: a libswamp not-found keeps its model spelling through userErrorFromSwampError", () => {
  // The shape libswamp's behaviorNotFound returns.
  const swampError = markModelWording(
    { code: "not_found", message: "Behavior not found: my-server" },
    "Model not found: my-server",
  );
  const error = userErrorFromSwampError(swampError);
  const json = captureStderr(() => renderError(error, "json", "model"));
  assertEquals(JSON.parse(json).error, "Model not found: my-server");
  const log = captureStderr(() => renderError(error, "log", "behavior"));
  assertStringIncludes(log, "Behavior not found: my-server");
});

Deno.test("renderError: a worded plain Error prints the model spelling in log mode under swamp model", async () => {
  const records: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => records.push(args.join(" "));
  try {
    await initializeLogging({});
    renderError(
      wordedError(wordedText((w) => `${w.Noun} type cannot be empty`)),
      "log",
      "model",
    );
  } finally {
    console.error = originalError;
  }
  const output = records.join("\n");
  assertStringIncludes(output, "Model type cannot be empty");
  assertEquals(output.includes("Behavior type"), false);
});

Deno.test("exitCodeForError: returns 75 for a commit that could not reach the storage, since nothing was committed (swamp-club#3759)", () => {
  assertEquals(
    exitCodeForError(new CommitUnreachableError(new Error("refused"))),
    75,
  );
  assertEquals(
    exitCodeForError(
      new CommitUnreachableError(new Error("refused")).afterStepsRan(),
    ),
    75,
  );
});

Deno.test("exitCodeForError: returns 75 for a reader that waited too long for another process's catch-up (swamp-club#3803)", () => {
  assertEquals(exitCodeForError(new ReadModelBusyError(60_000)), 75);
});

Deno.test("exitCodeForError: returns 1 for a run a checkpoint partly committed, since a retry would start another run (swamp-club#3802)", () => {
  const error = new RunPartlyCommittedError(new Error("refused"), [
    { workflowId: "wf-1", runId: "run-1" },
  ]);
  assertEquals(exitCodeForError(error), 1);
  assertEquals(exitCodeForError(error.afterStepsRan()), 1);
});

Deno.test("buildErrorJson: a run a checkpoint partly committed carries its code and the runs to recover (swamp-club#3802)", () => {
  const json = buildErrorJson(
    new RunPartlyCommittedError(new Error("refused"), [
      { workflowId: "wf-1", runId: "run-1" },
    ]).afterStepsRan(),
  );
  assertEquals(json.code, RUN_PARTLY_COMMITTED_CODE);
  assertEquals(json.runs, [
    { workflowId: "wf-1", runId: "run-1", acknowledgeUnknown: false },
  ]);
  assertStringIncludes(
    String(json.error),
    "swamp workflow recover wf-1 --run run-1",
  );
  assertEquals(json.stack, undefined);
});

Deno.test("buildErrorJson: a run cut while a step ran names that step and a recover command with --acknowledge-unknown, and says which runs need it; a run cut between steps keeps the plain command (swamp-club#3882)", () => {
  const error = new RunPartlyCommittedError(new Error("refused"), [
    { workflowId: "wf-1", runId: "run-1" },
    { workflowId: "wf-2", runId: "run-2" },
    { workflowId: "wf-3", runId: "run-3" },
  ]).withUnknownSteps((run) =>
    run.runId === "run-1" ? ["deploy"] : run.runId === "run-2" ? [] : undefined
  ).afterStepsRan();
  const json = buildErrorJson(error);
  assertEquals(json.code, RUN_PARTLY_COMMITTED_CODE);
  assertEquals(json.runs, [
    { workflowId: "wf-1", runId: "run-1", acknowledgeUnknown: true },
    { workflowId: "wf-2", runId: "run-2", acknowledgeUnknown: false },
    { workflowId: "wf-3", runId: "run-3", acknowledgeUnknown: false },
  ]);
  const message = String(json.error);
  assertStringIncludes(
    message,
    "to the datastore. Before that, check what step deploy of run run-1 " +
      "did outside swamp: it was running when the run was cut off, and the " +
      "recovery runs it again.",
  );
  assertStringIncludes(
    message,
    "swamp workflow recover wf-1 --run run-1 --acknowledge-unknown; " +
      "swamp workflow recover wf-2 --run run-2; " +
      "swamp workflow recover wf-3 --run run-3 in this checkout",
  );
  assertEquals(exitCodeForError(error), 1);
});

Deno.test("RunPartlyCommittedError: several steps in flight are named together, and the wording survives during() (swamp-club#3882)", () => {
  const error = new RunPartlyCommittedError(new Error("refused"), [
    { workflowId: "wf-1", runId: "run-1" },
  ]).withUnknownSteps(() => ["build", "test"]).during(new Error("boom"));
  assertStringIncludes(
    error.message,
    "Before that, check what steps build, test of run run-1 did outside " +
      "swamp: they were running when the run was cut off, and the recovery " +
      "runs them again.",
  );
  assertStringIncludes(
    error.message,
    "swamp workflow recover wf-1 --run run-1 --acknowledge-unknown in",
  );
  assertStringIncludes(error.message, "The command had also failed: boom.");
});

Deno.test("exitCodeForError: returns 75 for a datastore cut off while getting ready to write or while catching up, since nothing changed (swamp-club#3802)", () => {
  assertEquals(
    exitCodeForError(
      new V3StorageUnreachableError("/ds", new Error("ECONNRESET")),
    ),
    75,
  );
  assertEquals(
    exitCodeForError(
      new ReadModelCatchUpUnreachableError(
        new ReadModelApplyError("", "p", 3, "error reading a body"),
      ),
    ),
    75,
  );
});

Deno.test("exitCodeForError: returns 1 for a commit part of which had landed before the storage became unreachable (swamp-club#3802)", () => {
  const error = new CommitUnreachableError(new Error("refused"), {
    partly: true,
  });
  assertEquals(error.code, COMMIT_PARTLY_COMMITTED_CODE);
  assertEquals(exitCodeForError(error), 1);
  assertEquals(exitCodeForError(error.afterStepsRan()), 1);
});
