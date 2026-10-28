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

import { isTextContentType } from "../../data/content_type.ts";
import {
  dataQueryCommand,
  type DataQueryTarget,
} from "../../data/data_query_command.ts";
import type { DataHandle } from "../../models/model.ts";
import type { WorkflowReportContext } from "../report_context.ts";

/** Metadata only: persisting a report must not persist ephemeral content. */
export function dataPointer(handle: DataHandle, target: DataQueryTarget) {
  const ephemeral = handle.metadata.lifetime === "ephemeral";
  return {
    name: handle.name,
    kind: handle.kind,
    specName: handle.specName,
    version: handle.version,
    lifetime: handle.metadata.lifetime,
    availability: ephemeral ? "ephemeral" as const : "persistent" as const,
    ...(ephemeral ? {} : {
      retrievalCommand: dataQueryCommand(target, {
        includeContent: true,
        withEncoding: !isTextContentType(handle.metadata.contentType),
      }),
    }),
  };
}

export function stepDataPointers(
  workflowRunId: string,
  step: WorkflowReportContext["stepExecutions"][number],
) {
  return step.dataHandles.map((handle) =>
    dataPointer(handle, {
      workflowRunId,
      jobName: step.jobName,
      stepName: step.stepName,
      dataName: handle.name,
      version: handle.version,
    })
  );
}

export function retrievalCommands(
  pointers: ReturnType<typeof dataPointer>[],
): string[] {
  return pointers.flatMap((pointer) =>
    pointer.retrievalCommand ? [pointer.retrievalCommand] : []
  );
}

export function renderDataPointer(
  pointer: ReturnType<typeof dataPointer>,
): string {
  return pointer.retrievalCommand
    ? `\`${pointer.retrievalCommand}\``
    : `${pointer.name}: ephemeral — unavailable after the run. Use a durable lifetime to retrieve it later.`;
}
