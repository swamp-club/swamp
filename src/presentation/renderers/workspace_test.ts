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

import { assertEquals, assertRejects } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { UserError } from "../../domain/errors.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import type { WorkspaceCreateEvent } from "../../libswamp/workspace/create.ts";
import type { WorkspaceGetEvent } from "../../libswamp/workspace/get.ts";
import type { WorkspaceImportEvent } from "../../libswamp/workspace/import.ts";
import type { WorkspaceRemoveEvent } from "../../libswamp/workspace/remove.ts";
import type { OutputMode } from "../output/output.ts";
import {
  createWorkspaceCreateHandlers,
  createWorkspaceGetHandlers,
  createWorkspaceImportHandlers,
  createWorkspaceRemoveHandlers,
  workspaceListLines,
} from "./workspace.ts";

async function* toStream<E>(events: E[]): AsyncGenerator<E> {
  for (const event of events) yield event;
}

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(stripAnsiCode(msg));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

const removed = (mode: OutputMode, openInStart = false) =>
  capture(() =>
    consumeStream(
      toStream<WorkspaceRemoveEvent>([{
        kind: "completed",
        data: { name: "dev", path: "/data/workspaces/dev", openInStart },
      }]),
      createWorkspaceRemoveHandlers(mode),
    )
  );

Deno.test("workspaceListLines: aligns names and notes imports and missing folders", () => {
  const lines = workspaceListLines([
    {
      name: "dev",
      path: "/d/dev",
      createdAt: "",
      imported: false,
      folder: "missing",
    },
    {
      name: "infra-prod",
      path: "/code/infra",
      createdAt: "",
      imported: true,
      folder: "ok",
    },
  ]).map((l) => stripAnsiCode(l));
  assertEquals(lines, [
    "dev         /d/dev (folder missing)",
    "infra-prod  /code/infra (imported)",
  ]);
});

Deno.test("workspaceListLines: says how to create the first one", () => {
  assertEquals(workspaceListLines([]), [
    "No workspaces yet. Create one with 'swamp workspace create <name>'.",
  ]);
});

Deno.test("createWorkspaceRemoveHandlers: log mode says the folder is kept and how to bring it back", async () => {
  assertEquals(await removed("log"), [
    [
      "✓ Removed workspace dev",
      "  Its folder is still at /data/workspaces/dev",
      '  Bring it back with: swamp workspace import "/data/workspaces/dev"',
    ].join("\n"),
  ]);
  const open = (await removed("log", true))[0];
  assertEquals(
    open.includes("A swamp start still has this workspace open"),
    true,
  );
});

Deno.test("createWorkspaceRemoveHandlers: json mode prints the data", async () => {
  const [out] = await removed("json");
  assertEquals(JSON.parse(out), {
    name: "dev",
    path: "/data/workspaces/dev",
    openInStart: false,
  });
});

Deno.test("createWorkspaceRemoveHandlers: an error keeps its code", async () => {
  const error = await assertRejects(
    () =>
      consumeStream(
        toStream<WorkspaceRemoveEvent>([{
          kind: "error",
          error: { code: "not_found", message: 'No workspace named "x".' },
        }]),
        createWorkspaceRemoveHandlers("log"),
      ),
    UserError,
  );
  assertEquals(error.code, "not_found");
});

Deno.test("createWorkspaceCreateHandlers: log mode names the workspace and its folder", async () => {
  const logs = await capture(() =>
    consumeStream(
      toStream<WorkspaceCreateEvent>([{
        kind: "completed",
        data: { name: "prod", path: "/data/workspaces/prod" },
      }]),
      createWorkspaceCreateHandlers("log"),
    )
  );
  assertEquals(logs, ["✓ Created workspace prod: /data/workspaces/prod"]);
});

Deno.test("createWorkspaceImportHandlers: says when the folder was registered already", async () => {
  const run = (alreadyRegistered: boolean) =>
    capture(() =>
      consumeStream(
        toStream<WorkspaceImportEvent>([{
          kind: "completed",
          data: { name: "infra", path: "/code/infra", alreadyRegistered },
        }]),
        createWorkspaceImportHandlers("log"),
      )
    );
  assertEquals(await run(false), ["✓ Imported workspace infra: /code/infra"]);
  assertEquals(await run(true), [
    "• /code/infra is already the workspace infra",
  ]);
});

Deno.test("createWorkspaceGetHandlers: log mode shows every field, and open in swamp start only when it is", async () => {
  const run = (openInStart: boolean) =>
    capture(() =>
      consumeStream(
        toStream<WorkspaceGetEvent>([{
          kind: "completed",
          data: {
            name: "prod",
            path: "/data/workspaces/prod",
            createdAt: "2026-10-14T10:00:00.000Z",
            imported: false,
            folder: "missing",
            trusted: true,
            enrolledTools: [],
            openInStart,
          },
        }]),
        createWorkspaceGetHandlers("log"),
      )
    );
  const lines = [
    "Name: prod",
    "Path: /data/workspaces/prod (folder missing)",
    "Created: 2026-10-14T10:00:00.000Z",
    "Imported: no",
    "Trusted: yes",
    "Agents: none",
  ];
  assertEquals(await run(false), [lines.join("\n")]);
  assertEquals(await run(true), [
    [...lines, "Open in: swamp start"].join("\n"),
  ]);
});
