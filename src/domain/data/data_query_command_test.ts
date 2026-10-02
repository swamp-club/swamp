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

import { assertEquals } from "@std/assert";
import {
  dataQueryCommand,
  dataQueryPredicate,
  modelRetrievalCommand,
  stepRetrievalCommand,
} from "./data_query_command.ts";

Deno.test("dataQueryPredicate: a model-scoped read names the model, data name and version", () => {
  assertEquals(
    dataQueryPredicate({
      modelName: "my-server",
      dataName: "info",
      version: 2,
    }),
    'modelName == "my-server" && name == "info" && version == 2',
  );
});

Deno.test("dataQueryPredicate: a workflow-scoped read names the run, job and step", () => {
  assertEquals(
    dataQueryPredicate({
      workflowRunId: "run-1",
      jobName: "reviews",
      stepName: "code-review",
      dataName: "log",
      version: 1,
    }),
    'workflowRunId == "run-1" && jobName == "reviews" && ' +
      'stepName == "code-review" && name == "log" && version == 1',
  );
});

Deno.test("dataQueryPredicate: omits the version when none is given", () => {
  assertEquals(
    dataQueryPredicate({ modelName: "m", dataName: "n" }),
    'modelName == "m" && name == "n"',
  );
});

Deno.test("dataQueryPredicate: escapes quotes and backslashes in names", () => {
  assertEquals(
    dataQueryPredicate({ modelName: 'a"b', dataName: "c\\d" }),
    'modelName == "a\\"b" && name == "c\\\\d"',
  );
});

Deno.test("dataQueryCommand: selects content when the read includes it", () => {
  assertEquals(
    dataQueryCommand({ modelName: "m", dataName: "n", version: 1 }, {
      includeContent: true,
    }),
    `swamp data query 'modelName == "m" && name == "n" && version == 1' --select content`,
  );
});

Deno.test("dataQueryCommand: lists metadata when the read omits content", () => {
  assertEquals(
    dataQueryCommand({ modelName: "m", dataName: "n" }, {
      includeContent: false,
    }),
    `swamp data query 'modelName == "m" && name == "n"'`,
  );
});

Deno.test("dataQueryCommand: shell-quotes a single quote inside a name", () => {
  assertEquals(
    dataQueryCommand({ modelName: "it's", dataName: "n" }, {
      includeContent: false,
    }),
    `swamp data query 'modelName == "it'"'"'s" && name == "n"'`,
  );
});

Deno.test("stepRetrievalCommand: reads a step's item by run, job, step, name and version", () => {
  assertEquals(
    stepRetrievalCommand(
      "run-1",
      { jobName: "tests", stepName: "lint", modelName: "lint-model" },
      { name: "log", version: 3, contentType: "text/plain" },
    ),
    `swamp data query 'workflowRunId == "run-1" && jobName == "tests" && ` +
      `stepName == "lint" && name == "log" && version == 3' --select content`,
  );
});

Deno.test("stepRetrievalCommand: a binary item keeps data get, which returns its bytes", () => {
  assertEquals(
    stepRetrievalCommand(
      "run-1",
      { jobName: "build", stepName: "package", modelName: "packager" },
      { name: "bundle.tar", version: 2, contentType: "application/x-tar" },
    ),
    "swamp data get packager bundle.tar --version 2",
  );
});

Deno.test("modelRetrievalCommand: reads one version of a model's text data", () => {
  assertEquals(
    modelRetrievalCommand("my-server", {
      name: "info",
      version: 4,
      contentType: "application/json",
    }),
    `swamp data query 'modelName == "my-server" && name == "info" && version == 4' --select content`,
  );
});

Deno.test("dataQueryPredicate: names the model type when given", () => {
  assertEquals(
    dataQueryPredicate({
      modelType: "workflow",
      modelName: "wf",
      dataName: "r",
    }),
    'modelType == "workflow" && modelName == "wf" && name == "r"',
  );
});
