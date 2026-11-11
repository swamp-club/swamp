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

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { writeRunRecordYaml } from "./run_record_yaml.ts";

const workflowId = crypto.randomUUID();
const runId = crypto.randomUUID();

// the shape a serial command/shell step leaves in its record
function step(index: number): Record<string, unknown> {
  const stepName = `s${index}`;
  const resourceId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const modelId = crypto.randomUUID();
  const tags = (type: string) => ({
    type,
    specName: type === "file" ? "log" : "result",
    modelName: "sh1",
    source: "step-output",
    workflow: "bench",
    workflowId,
    workflowRunId: runId,
    job: "main",
    step: stepName,
    initiatedBy: "user:bench",
    "_swamp.kind": type,
  });
  const artifacts = [
    { dataId: resourceId, name: "result", version: 1, tags: tags("resource") },
    { dataId: fileId, name: "log", version: 1, tags: tags("file") },
  ];
  return {
    stepName,
    status: "succeeded",
    startedAt: new Date(Date.UTC(2026, 10, 11, 14, 0, index)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 10, 11, 14, 0, index + 1))
      .toISOString(),
    output: {
      type: "model_method",
      model: "sh1",
      method: "execute",
      resources: {
        result: {
          result: {
            id: resourceId,
            name: "result",
            version: 1,
            isLatest: true,
            createdAt: "2026-11-11T14:00:00.000Z",
            namespace: "",
            attributes: null,
            tags: tags("resource"),
            modelId,
            modelType: "command/shell",
            contentType: "application/json",
            size: 121,
            path: "",
            ownerRef: modelId,
          },
        },
      },
      files: {
        log: {
          log: {
            id: fileId,
            version: 1,
            path: `/tmp/bench/.swamp/data/command/shell/${modelId}/log/1/raw`,
            size: 14,
            contentType: "text/plain",
          },
        },
      },
      dataArtifacts: artifacts,
    },
    dataArtifacts: artifacts,
  };
}

function record(steps: number): Record<string, unknown> {
  return {
    id: runId,
    workflowId,
    workflowName: "bench",
    status: "running",
    startedAt: "2026-11-11T14:00:00.000Z",
    jobs: [{
      jobName: "main",
      status: "running",
      steps: Array.from({ length: steps }, (_, i) => step(i + 1)),
    }],
    tags: {},
  };
}

for (const steps of [10, 50, 100]) {
  // the clone save() makes: no shared objects, so stringify writes no aliases
  const data = JSON.parse(JSON.stringify(record(steps)));
  const group = `${steps} steps`;
  Deno.bench({
    name: `@std/yaml stringify, ${steps} steps`,
    group,
    baseline: true,
    fn: () => {
      stringifyYaml(data);
    },
  });
  Deno.bench({
    name: `writeRunRecordYaml, ${steps} steps`,
    group,
    fn: () => {
      writeRunRecordYaml(data);
    },
  });
  const older = stringifyYaml(data);
  const newer = writeRunRecordYaml(data);
  Deno.bench({
    name: `@std/yaml parse of stringify output, ${steps} steps`,
    group: `${group}, read`,
    baseline: true,
    fn: () => {
      parseYaml(older);
    },
  });
  Deno.bench({
    name: `@std/yaml parse of writeRunRecordYaml output, ${steps} steps`,
    group: `${group}, read`,
    fn: () => {
      parseYaml(newer);
    },
  });
}
