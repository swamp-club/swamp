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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import {
  AppendUnrecordedError,
  CommitUnreachableError,
  LEASE_LAPSED_CODE,
  RunPartlyCommittedError,
} from "../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ReadModelCatchUpUnreachableError } from "../domain/datastore_v3/read_model.ts";
import {
  isLapsedServeRequest,
  V3StorageUnreachableError,
} from "../domain/datastore_v3/writer_lease.ts";
import { StepStartUnrecordedError } from "../domain/workflows/step_start.ts";
import {
  ServeLeaseLapsedLatch,
  ServeLeaseLapsedRequestError,
  ServeUnreachableError,
} from "../infrastructure/datastore_v3/serve_upstream_errors.ts";
import {
  alreadyExists,
  cancelled,
  datastoreOutageOf,
  invalidApiKey,
  isSwampError,
  notAuthenticated,
  notFound,
  userErrorFromSwampError,
  validationFailed,
} from "./errors.ts";

Deno.test("notAuthenticated returns correct error", () => {
  const err = notAuthenticated();
  assertEquals(err.code, "not_authenticated");
  assertEquals(
    err.message,
    "Not authenticated. Run 'swamp auth login' to sign in.",
  );
});

Deno.test("invalidApiKey returns correct error", () => {
  const err = invalidApiKey();
  assertEquals(err.code, "invalid_api_key");
});

Deno.test("cancelled returns correct error", () => {
  const cause = new Error("abort");
  const err = cancelled(cause);
  assertEquals(err.code, "cancelled");
  assertEquals(err.cause, cause);
});

Deno.test("notFound returns correct error with details", () => {
  const err = notFound("Model", "my-model");
  assertEquals(err.code, "not_found");
  assertEquals(err.message, "Model not found: my-model");
  assertEquals(err.details, { entityType: "Model", idOrName: "my-model" });
});

Deno.test("alreadyExists returns correct error with details", () => {
  const err = alreadyExists("Vault", "my-vault");
  assertEquals(err.code, "already_exists");
  assertEquals(err.message, "Vault already exists: my-vault");
  assertEquals(err.details, { entityType: "Vault", name: "my-vault" });
});

Deno.test("validationFailed returns correct error", () => {
  const err = validationFailed("Bad input", { field: "name" });
  assertEquals(err.code, "validation_failed");
  assertEquals(err.message, "Bad input");
  assertEquals(err.details, { field: "name" });
});

Deno.test("validationFailed works without details", () => {
  const err = validationFailed("Missing argument");
  assertEquals(err.code, "validation_failed");
  assertEquals(err.details, undefined);
});

Deno.test("isSwampError: accepts a SwampError from a factory", () => {
  assertEquals(isSwampError(notFound("Model", "missing")), true);
});

Deno.test("isSwampError: rejects values that are not SwampError-shaped", () => {
  assertEquals(isSwampError(new Error("boom")), false);
  assertEquals(
    isSwampError(
      Object.assign(new Error("A secret was not found"), {
        code: "SecretNotFound",
      }),
    ),
    false,
  );
  assertEquals(isSwampError(null), false);
  assertEquals(isSwampError(undefined), false);
  assertEquals(isSwampError("not_found"), false);
  assertEquals(isSwampError({ code: "not_found" }), false);
  assertEquals(isSwampError({ code: 404, message: "Model not found" }), false);
});

Deno.test("userErrorFromSwampError: keeps message and code and carries the cause's marked paths", () => {
  const path = "/srv/acme/final report";
  const cause = markErrorPaths(new Error(`cannot read ${path}`), [path]);
  const error = userErrorFromSwampError({
    code: "method_execution_failed",
    message: `Method execution failed: cannot read ${path}`,
    cause,
  });
  assertInstanceOf(error, UserError);
  assertEquals(error.message, `Method execution failed: cannot read ${path}`);
  assertEquals(error.code, "method_execution_failed");
  assertEquals(errorPaths(error), [path]);
});

Deno.test("userErrorFromSwampError: marks nothing when there is no cause", () => {
  const error = userErrorFromSwampError(notFound("Model", "x"));
  assertEquals(error.code, "not_found");
  assertEquals(errorPaths(error), []);
});

function serveCutOff(): ServeUnreachableError {
  return new ServeUnreachableError(
    "http://serve.test",
    "maybe",
    new Error("Serve did not start its reply"),
  );
}

Deno.test("userErrorFromSwampError: a serve outage in the cause is kept, and the outermost datastore code in the chain is reported", () => {
  const unreachable = serveCutOff();
  const start = new StepStartUnrecordedError(
    new AppendUnrecordedError(unreachable, false),
    { workflowId: "w", workflowName: "deploy", runId: "r", stepName: "s2" },
  );
  const error = userErrorFromSwampError({
    code: "workflow_execution_failed",
    message: `Workflow execution failed: ${start.message}`,
    cause: start,
  });
  assertEquals(error.code, "datastore_v3_commit_unreachable");
  assertEquals(error.cause, start);
  const direct = userErrorFromSwampError({
    code: "workflow_execution_failed",
    message: "Workflow execution failed",
    cause: new Error("the run stopped", { cause: unreachable }),
  });
  assertEquals(direct.code, "datastore_v3_serve_unreachable");
});

Deno.test("userErrorFromSwampError: each outage class teardown walks for is kept", () => {
  const unreachable = serveCutOff();
  for (
    const outage of [
      unreachable,
      new CommitUnreachableError(new Error("down")),
      new V3StorageUnreachableError("/store", new Error("down")),
      new ReadModelCatchUpUnreachableError(new Error("down")),
      new RunPartlyCommittedError(new Error("down"), [{
        workflowId: "w",
        runId: "r",
      }]),
    ]
  ) {
    const error = userErrorFromSwampError({
      code: "workflow_execution_failed",
      message: "Workflow execution failed",
      cause: outage,
    });
    assertEquals(error.cause, outage, outage.name);
    assertEquals(error.code, (outage as { code?: string }).code, outage.name);
  }
});

Deno.test("userErrorFromSwampError: a lapsed request's wrapper exits as the lapse does", () => {
  const error = userErrorFromSwampError({
    code: "workflow_execution_failed",
    message: "Workflow execution failed",
    cause: new ServeLeaseLapsedRequestError(
      "http://serve.test",
      "maybe",
      new ServeLeaseLapsedLatch("data/x/y/.lock"),
      { route: "commits", bodyBytes: 0 },
    ),
  });
  assertEquals(error.code, LEASE_LAPSED_CODE);
  assertEquals(isLapsedServeRequest(error), true);
});

Deno.test("userErrorFromSwampError: a failure without an outage keeps no cause and its own code", () => {
  for (
    const cause of [
      new Error("the method failed"),
      new UserError("refused", "datastore_v3_commit_rejected"),
      new UserError("not the leader", "serve_not_leader"),
    ]
  ) {
    const error = userErrorFromSwampError({
      code: "workflow_execution_failed",
      message: "Workflow execution failed",
      cause,
    });
    assertEquals(error.code, "workflow_execution_failed");
    assertEquals(error.cause, undefined);
  }
});

Deno.test("datastoreOutageOf: undefined without an outage in the chain", () => {
  assertEquals(datastoreOutageOf(new Error("boom")), undefined);
  assertEquals(datastoreOutageOf("boom"), undefined);
  assertEquals(datastoreOutageOf(undefined), undefined);
});
