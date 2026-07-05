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
import { createStdioReader, StdioTransport } from "./stdio_transport.ts";

function makeFrame(data: string): Uint8Array {
  const encoder = new TextEncoder();
  const payload = encoder.encode(data);
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

Deno.test("StdioTransport: frame round-trip through pipe", async () => {
  const received: string[] = [];

  const { readable, writable } = new TransformStream<Uint8Array>();
  const transport = new StdioTransport(writable);

  const readerDone = createStdioReader(
    readable,
    (data) => received.push(data),
    () => {},
  );

  transport.send('{"method":"echo","params":{}}');
  transport.send('{"method":"ping","params":{"x":1}}');
  await transport.close();
  await readerDone;

  assertEquals(received, [
    '{"method":"echo","params":{}}',
    '{"method":"ping","params":{"x":1}}',
  ]);
});

Deno.test("createStdioReader: handles embedded newlines in payload", async () => {
  const received: string[] = [];
  const payload = '{"data":"line1\\nline2\\nline3"}';

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(makeFrame(payload));
      controller.close();
    },
  });

  await createStdioReader(
    stream,
    (data) => received.push(data),
    () => {},
  );

  assertEquals(received, [payload]);
});

Deno.test("createStdioReader: reassembles frames split across chunks", async () => {
  const received: string[] = [];
  const frame = makeFrame('{"id":"split-test"}');

  // Split the frame at various points: mid-header, mid-payload
  const chunk1 = frame.subarray(0, 2); // First 2 bytes of header
  const chunk2 = frame.subarray(2, 6); // Last 2 bytes of header + first 2 of payload
  const chunk3 = frame.subarray(6); // Rest of payload

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk1);
      controller.enqueue(chunk2);
      controller.enqueue(chunk3);
      controller.close();
    },
  });

  await createStdioReader(
    stream,
    (data) => received.push(data),
    () => {},
  );

  assertEquals(received, ['{"id":"split-test"}']);
});

Deno.test("createStdioReader: handles multiple frames in one chunk", async () => {
  const received: string[] = [];
  const frame1 = makeFrame('{"a":1}');
  const frame2 = makeFrame('{"b":2}');

  const combined = new Uint8Array(frame1.byteLength + frame2.byteLength);
  combined.set(frame1, 0);
  combined.set(frame2, frame1.byteLength);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(combined);
      controller.close();
    },
  });

  await createStdioReader(
    stream,
    (data) => received.push(data),
    () => {},
  );

  assertEquals(received, ['{"a":1}', '{"b":2}']);
});

Deno.test("createStdioReader: calls onClose when stream ends", async () => {
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  await createStdioReader(
    stream,
    () => {},
    () => {
      closed = true;
    },
  );

  assertEquals(closed, true);
});

Deno.test("createStdioReader: handles empty payload", async () => {
  const received: string[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(makeFrame(""));
      controller.close();
    },
  });

  await createStdioReader(
    stream,
    (data) => received.push(data),
    () => {},
  );

  assertEquals(received, [""]);
});
