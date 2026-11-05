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
  logFromOutputs,
  logFromQueryReply,
  parseLog,
  pickLogArtifact,
  stepLogQuery,
} from "./step_log.ts";

const ref = (name: string, tags: Record<string, string>) => ({
  dataId: `${name}-id`,
  name,
  version: 3,
  tags,
});

Deno.test("pickLogArtifact: prefers the log file, ignores non-files", () => {
  const refs = [
    ref("result", { type: "resource", modelName: "sh" }),
    ref("dump", { type: "file", modelName: "sh" }),
    ref("log", { type: "file", specName: "log", modelName: "sh" }),
  ];
  assertEquals(pickLogArtifact(refs)?.name, "log");
  assertEquals(pickLogArtifact(refs.slice(0, 2))?.name, "dump");
  assertEquals(pickLogArtifact(refs.slice(0, 1)), null);
  assertEquals(pickLogArtifact(undefined), null);
});

Deno.test("parseLog: tags lines with their stream and drops markers", () => {
  const { lines, truncated } = parseLog(
    "preamble\n[stdout]\nnotify-0\n[stderr]\nboom\n",
  );
  assertEquals(truncated, 0);
  assertEquals(lines, [
    { text: "preamble", stream: null },
    { text: "notify-0", stream: "stdout" },
    { text: "boom", stream: "stderr" },
  ]);
});

Deno.test("parseLog: keeps the tail of a long log", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const { lines, truncated } = parseLog(text, 3);
  assertEquals(truncated, 7);
  assertEquals(lines.map((l) => l.text), ["line 7", "line 8", "line 9"]);
});

Deno.test("logFromOutputs: rebuilds a log from captured output", () => {
  assertEquals(
    logFromOutputs({ stdout: "ok", stderr: "", exitCode: 0 }),
    "[stdout]\nok",
  );
  assertEquals(logFromOutputs({ exitCode: 0 }), null);
  assertEquals(logFromOutputs(undefined), null);
});

const runTags = {
  type: "file",
  modelName: "review-cb586fdc",
  workflowRunId: "cb586fdc-3919-4db5-95a5-df200f59c514",
  job: "review",
  step: "comments",
};

Deno.test("stepLogQuery: pins the run, job, step, name and version the artifact recorded", () => {
  assertEquals(stepLogQuery(ref("log", runTags)), {
    predicate: 'workflowRunId == "cb586fdc-3919-4db5-95a5-df200f59c514" && ' +
      'jobName == "review" && stepName == "comments" && name == "log" && ' +
      "version == 3",
    select: '{"content": content, "contentEncoding": contentEncoding}',
    limit: 1,
  });
});

Deno.test("stepLogQuery: keeps quotes, backslashes and unicode inside one string literal", () => {
  const query = stepLogQuery(
    ref("log", { ...runTags, job: 'a" || true || "', step: "s\\ü-[item]" }),
  );
  assertEquals(
    query?.predicate,
    'workflowRunId == "cb586fdc-3919-4db5-95a5-df200f59c514" && ' +
      'jobName == "a\\" || true || \\"" && stepName == "s\\\\ü-[item]" && ' +
      'name == "log" && version == 3',
  );
});

Deno.test("stepLogQuery: null when the artifact lacks a run, job or step tag", () => {
  for (const missing of ["workflowRunId", "job", "step"]) {
    const tags: Record<string, string> = { ...runTags };
    delete tags[missing];
    assertEquals(stepLogQuery(ref("log", tags)), null, missing);
  }
  assertEquals(stepLogQuery({ dataId: "d", name: "log", version: 1 }), null);
});

const projected = (rows: Record<string, unknown>[]) => ({
  data: {
    results: [],
    projected: { shape: "map", columns: ["content", "contentEncoding"], rows },
    total: rows.length,
    limited: false,
  },
});

Deno.test("logFromQueryReply: reads the first projected row, or null for none", () => {
  assertEquals(
    logFromQueryReply(
      projected([{ content: "[stdout]\nhello", contentEncoding: "utf-8" }]),
    ),
    { content: "[stdout]\nhello", contentEncoding: "utf-8" },
  );
  assertEquals(
    logFromQueryReply(
      projected([{ content: "AAE=", contentEncoding: "base64" }]),
    ),
    { content: "AAE=", contentEncoding: "base64" },
  );
  assertEquals(logFromQueryReply(projected([])), null);
  assertEquals(
    logFromQueryReply({ data: { results: [], total: 0, limited: false } }),
    null,
  );
  assertEquals(logFromQueryReply(null), null);
});
