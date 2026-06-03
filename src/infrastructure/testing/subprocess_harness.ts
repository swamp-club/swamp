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

import { dirname, fromFileUrl, join } from "@std/path";

const ENTRY_SCRIPT = join(
  dirname(fromFileUrl(import.meta.url)),
  "subprocess_entry.ts",
);

export interface SubprocessHandle {
  process: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<string>;
}

export interface ImportResult {
  status: string;
  hasExport?: boolean;
  exportKeys?: string[];
  fingerprint?: string;
  version?: string | null;
  error?: string;
}

export interface HeapResult {
  status: string;
  bytes: number;
}

export async function spawnExtensionProcess(): Promise<SubprocessHandle> {
  const command = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-write", "--allow-env", ENTRY_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });

  const process = command.spawn();
  const stdin = process.stdin.getWriter();
  const reader = process.stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new LineStream())
    .getReader();

  const handle: SubprocessHandle = { process, stdin, reader };

  const ready = await readResponse(handle);
  if (ready.status !== "ready") {
    throw new Error(`Subprocess failed to start: ${JSON.stringify(ready)}`);
  }

  return handle;
}

export async function importInSubprocess(
  handle: SubprocessHandle,
  bundlePath: string,
  fingerprint: string,
  exportKey: string,
): Promise<ImportResult> {
  await sendRequest(handle, {
    action: "import",
    bundlePath,
    fingerprint,
    exportKey,
  });
  return await readResponse(handle) as unknown as ImportResult;
}

export async function measureHeap(
  handle: SubprocessHandle,
): Promise<HeapResult> {
  await sendRequest(handle, { action: "heap" });
  return await readResponse(handle) as unknown as HeapResult;
}

export async function killSubprocess(
  handle: SubprocessHandle,
): Promise<void> {
  try {
    handle.stdin.releaseLock();
    await handle.process.stdin.close();
  } catch {
    // stdin may already be closed
  }
  try {
    handle.reader.releaseLock();
  } catch {
    // reader may already be released
  }
  try {
    handle.process.kill("SIGTERM");
  } catch {
    // process may already be dead
  }
  await handle.process.status.catch(() => {});
}

async function sendRequest(
  handle: SubprocessHandle,
  request: Record<string, unknown>,
): Promise<void> {
  const encoder = new TextEncoder();
  await handle.stdin.write(encoder.encode(JSON.stringify(request) + "\n"));
}

async function readResponse(
  handle: SubprocessHandle,
): Promise<Record<string, unknown>> {
  const { value, done } = await handle.reader.read();
  if (done || !value) {
    throw new Error("Subprocess closed unexpectedly");
  }
  return JSON.parse(value);
}

class LineStream extends TransformStream<string, string> {
  constructor() {
    let buffer = "";
    super({
      transform(chunk, controller) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) {
            controller.enqueue(line.trim());
          }
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          controller.enqueue(buffer.trim());
        }
      },
    });
  }
}
