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

/**
 * Mock dispatch runner for unit testing the supervisor's spawn logic.
 * Reads the bootstrap frame from stdin, optionally delays, then writes
 * a success result back using length-prefixed framing.
 */

const HEADER_SIZE = 4;

function writeFrame(data: string): void {
  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, HEADER_SIZE);
  Deno.stdout.writeSync(frame);
}

// Read the bootstrap frame by consuming raw bytes from stdin.
const buf = new Uint8Array(65536);
let read = 0;
while (read < HEADER_SIZE) {
  const n = Deno.stdin.readSync(buf.subarray(read));
  if (n === null) Deno.exit(1);
  read += n;
}
const payloadLen = new DataView(buf.buffer).getUint32(0);
while (read < HEADER_SIZE + payloadLen) {
  const n = Deno.stdin.readSync(buf.subarray(read));
  if (n === null) Deno.exit(1);
  read += n;
}

const bootstrapJson = new TextDecoder().decode(
  buf.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen),
);
const bootstrap = JSON.parse(bootstrapJson);
const delayMs =
  (bootstrap?.dispatch?.execution?.methodArgs?.delayMs as number) ?? 0;

if (delayMs > 0) {
  await new Promise<void>((r) => setTimeout(r, delayMs));
}

writeFrame(JSON.stringify({
  type: "runner.result",
  result: {
    status: "success",
    outputs: [],
    logs: [],
    durationMs: delayMs || 1,
  },
}));
