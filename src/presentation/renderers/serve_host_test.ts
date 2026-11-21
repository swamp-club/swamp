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
import { configure, reset } from "@logtape/logtape";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createServeHostRenderer,
  type ServeHostRenderer,
} from "./serve_host.ts";

await initializeLogging({});

const LISTENING = {
  host: "0.0.0.0",
  port: 443,
  url: "https://0.0.0.0:443",
  address: "https://serve.acme.internal",
  root: true,
  rootWorkspace: null,
  workspaces: 2,
};

const ROOT_WORKSPACE = {
  name: "host-root",
  folder: "/home/op/.local/share/swamp/workspaces/host-root",
  created: true,
  serveConfig:
    "/home/op/.local/share/swamp/workspaces/host-root/.swamp/serve.yaml",
  leftFolder: null,
};

function captureStdout(fn: () => void): string[] {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return output;
}

async function captureLog(
  fn: (renderer: ServeHostRenderer) => void,
): Promise<string[]> {
  const messages: string[] = [];
  await configure({
    reset: true,
    sinks: {
      kept: (record) => {
        messages.push(record.message.map((part) => String(part)).join(""));
      },
    },
    loggers: [
      { category: ["serve"], sinks: ["kept"], lowestLevel: "info" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  try {
    fn(createServeHostRenderer("log"));
  } finally {
    await reset();
    await initializeLogging({});
  }
  return messages;
}

Deno.test("serveHostRenderer json: prints a line for listening, each workspace change and the stop", () => {
  const renderer = createServeHostRenderer("json");
  const output = captureStdout(() => {
    renderer.listening(LISTENING);
    renderer.workspacesChanged({ added: ["x"], removed: ["y"] });
    renderer.stopped();
  });
  assertEquals(output.map((line) => JSON.parse(line)), [
    { status: "listening", ...LISTENING },
    { status: "workspaces", added: ["x"], removed: ["y"] },
    { status: "stopped" },
  ]);
});

Deno.test("serveHostRenderer log: reports listening, each workspace change and the stop", async () => {
  const messages = await captureLog((renderer) => {
    renderer.listening(LISTENING);
    renderer.workspacesChanged({ added: ["edge-dns"], removed: ["old"] });
    renderer.stopped();
  });
  assertEquals(messages.length, 4);
  assertEquals(messages[0].includes("https://serve.acme.internal"), true);
  assertEquals(messages[0].includes("with a root and 2 workspace(s)"), true);
  assertEquals(messages[1].includes("edge-dns"), true);
  assertEquals(messages[1].includes("added"), true);
  assertEquals(messages[2].includes("old"), true);
  assertEquals(messages[2].includes("removed"), true);
  assertEquals(messages[3], "Serve host stopped");
});

Deno.test("serveHostRenderer json: prints the created file as a line of its own", () => {
  const renderer = createServeHostRenderer("json");
  const output = captureStdout(() => {
    renderer.created({
      file: "/home/op/.config/swamp/host.yaml",
      rootWorkspace: "host-root",
    });
    renderer.listening(LISTENING);
  });
  assertEquals(output.map((line) => JSON.parse(line)), [
    {
      status: "created",
      file: "/home/op/.config/swamp/host.yaml",
      rootWorkspace: "host-root",
    },
    { status: "listening", ...LISTENING },
  ]);
});

Deno.test("serveHostRenderer log: names the created file and the root workspace the host uses", async () => {
  const messages = await captureLog((renderer) => {
    renderer.created({
      file: "/home/op/.config/swamp/host.yaml",
      rootWorkspace: "host-root",
    });
  });
  assertEquals(messages.length, 1);
  assertEquals(messages[0].includes("/home/op/.config/swamp/host.yaml"), true);
  assertEquals(messages[0].includes("127.0.0.1:8080"), true);
  assertEquals(messages[0].includes("root workspace host-root"), true);
  assertEquals(messages[0].includes("root:"), true);
});

Deno.test("serveHostRenderer json: says which workspace is the root", () => {
  const renderer = createServeHostRenderer("json");
  const output = captureStdout(() => {
    renderer.rootWorkspace(ROOT_WORKSPACE);
    renderer.listening({ ...LISTENING, rootWorkspace: "host-root" });
  });
  assertEquals(output.map((line) => JSON.parse(line)), [
    { status: "root_workspace", ...ROOT_WORKSPACE },
    { status: "listening", ...LISTENING, rootWorkspace: "host-root" },
  ]);
});

Deno.test("serveHostRenderer log: names the root workspace, its folder and what its default auth allows", async () => {
  const messages = await captureLog((renderer) => {
    renderer.rootWorkspace(ROOT_WORKSPACE);
    renderer.rootWorkspace({
      ...ROOT_WORKSPACE,
      created: false,
      leftFolder: "/old/host-root",
    });
    renderer.listening({ ...LISTENING, rootWorkspace: "host-root" });
  });
  assertEquals(messages.length, 4);
  assertEquals(messages[0].startsWith("Created root workspace"), true);
  assertEquals(messages[0].includes(ROOT_WORKSPACE.folder), true);
  assertEquals(messages[0].includes(ROOT_WORKSPACE.serveConfig), true);
  assertEquals(messages[0].includes("anyone on this machine"), true);
  assertEquals(messages[1].startsWith("Starting root workspace"), true);
  assertEquals(messages[1].includes("anyone on this machine"), true);
  assertEquals(messages[2].includes("/old/host-root"), true);
  assertEquals(
    messages[3].includes("with root workspace host-root and 2"),
    true,
  );
});
