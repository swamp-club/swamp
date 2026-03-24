// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import {
  type AuthWhoamiEvent,
  consumeStream,
  type DataListEvent,
  type DataSearchEvent,
  type ModelSearchEvent,
  withDefaults,
  type WorkflowRunEvent,
  type WorkflowSearchEvent,
} from "../libswamp/mod.ts";
import type { CommandResponse, ProgressUpdate } from "./types.ts";

type ProgressCallback = (update: ProgressUpdate) => void;

/**
 * Consume a workflow run event stream and produce a chat-friendly response.
 */
export async function formatWorkflowRun(
  stream: AsyncIterable<WorkflowRunEvent>,
  onProgress?: ProgressCallback,
): Promise<CommandResponse> {
  let workflowName = "";
  const jobResults: string[] = [];
  let errorMessage: string | null = null;
  let runId = "";

  await consumeStream(
    stream,
    withDefaults<WorkflowRunEvent>(
      {
        started: (e) => {
          workflowName = e.workflowName;
          runId = e.runId;
          onProgress?.({ text: `Running workflow '${workflowName}'...` });
        },
        job_completed: (e) => {
          const status = e.status === "succeeded" ? "succeeded" : "failed";
          jobResults.push(`- Job '${e.jobId}': ${status}`);
          onProgress?.({
            text: `Job '${e.jobId}' ${status}`,
          });
        },
        completed: (e) => {
          workflowName = e.run.workflowName;
          runId = e.run.id;
        },
        error: (e) => {
          errorMessage = e.error.message;
        },
      },
    ),
  );

  if (errorMessage) {
    return {
      text: `Workflow '${workflowName}' failed: ${errorMessage}`,
      success: false,
    };
  }

  const lines = [
    `**Workflow '${workflowName}' completed** (${runId})`,
    ...jobResults,
  ];
  return { text: lines.join("\n"), success: true };
}

/**
 * Consume a workflow search event stream and produce a chat-friendly response.
 */
export async function formatWorkflowSearch(
  stream: AsyncIterable<WorkflowSearchEvent>,
): Promise<CommandResponse> {
  const items: string[] = [];
  let errorMessage: string | null = null;

  await consumeStream(
    stream,
    withDefaults<WorkflowSearchEvent>({
      completed: (e) => {
        for (const item of e.data.results) {
          items.push(`- **${item.name}** (${item.id})`);
        }
      },
      error: (e) => {
        errorMessage = e.error.message;
      },
    }),
  );

  if (errorMessage) {
    return { text: `Search failed: ${errorMessage}`, success: false };
  }
  if (items.length === 0) {
    return { text: "No workflows found.", success: true };
  }
  return {
    text: `**Workflows** (${items.length})\n${items.join("\n")}`,
    success: true,
  };
}

/**
 * Consume an auth whoami event stream and produce a chat-friendly response.
 */
export async function formatWhoami(
  stream: AsyncIterable<AuthWhoamiEvent>,
): Promise<CommandResponse> {
  let errorMessage: string | null = null;
  let identity = "";

  await consumeStream(
    stream,
    withDefaults<AuthWhoamiEvent>({
      completed: (e) => {
        identity =
          `Logged in as **${e.identity.username}** (${e.identity.email})`;
      },
      error: (e) => {
        errorMessage = e.error.message;
      },
    }),
  );

  if (errorMessage) {
    return { text: `Auth check failed: ${errorMessage}`, success: false };
  }
  return { text: identity, success: true };
}

/**
 * Consume a data list event stream and produce a chat-friendly response.
 */
export async function formatDataList(
  stream: AsyncIterable<DataListEvent>,
): Promise<CommandResponse> {
  const items: string[] = [];
  let errorMessage: string | null = null;

  await consumeStream(
    stream,
    withDefaults<DataListEvent>({
      completed: (e) => {
        for (const group of e.data.groups) {
          for (const item of group.items) {
            items.push(`- **${item.name}** (${item.type})`);
          }
        }
      },
      error: (e) => {
        errorMessage = e.error.message;
      },
    }),
  );

  if (errorMessage) {
    return { text: `Data list failed: ${errorMessage}`, success: false };
  }
  if (items.length === 0) {
    return { text: "No data found.", success: true };
  }
  return {
    text: `**Data** (${items.length})\n${items.join("\n")}`,
    success: true,
  };
}

/**
 * Consume a data search event stream and produce a chat-friendly response.
 */
export async function formatDataSearch(
  stream: AsyncIterable<DataSearchEvent>,
): Promise<CommandResponse> {
  const items: string[] = [];
  let errorMessage: string | null = null;

  await consumeStream(
    stream,
    withDefaults<DataSearchEvent>({
      completed: (e) => {
        for (const item of e.data.results) {
          items.push(`- **${item.name}** (${item.type})`);
        }
      },
      error: (e) => {
        errorMessage = e.error.message;
      },
    }),
  );

  if (errorMessage) {
    return { text: `Data search failed: ${errorMessage}`, success: false };
  }
  if (items.length === 0) {
    return { text: "No matching data found.", success: true };
  }
  return {
    text: `**Search results** (${items.length})\n${items.join("\n")}`,
    success: true,
  };
}

/**
 * Consume a model search event stream and produce a chat-friendly response.
 */
export async function formatModelSearch(
  stream: AsyncIterable<ModelSearchEvent>,
): Promise<CommandResponse> {
  const items: string[] = [];
  let errorMessage: string | null = null;

  await consumeStream(
    stream,
    withDefaults<ModelSearchEvent>({
      completed: (e) => {
        for (const item of e.data.results) {
          items.push(`- **${item.name}** (${item.type}): ${item.id}`);
        }
      },
      error: (e) => {
        errorMessage = e.error.message;
      },
    }),
  );

  if (errorMessage) {
    return { text: `Model search failed: ${errorMessage}`, success: false };
  }
  if (items.length === 0) {
    return { text: "No models found.", success: true };
  }
  return {
    text: `**Models** (${items.length})\n${items.join("\n")}`,
    success: true,
  };
}
