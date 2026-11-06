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

const FLUSH_CHARS = 64 * 1024;

type Sink = (bytes: Uint8Array) => Promise<number>;

function viaToJSON(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null &&
      typeof (value as { toJSON?: unknown }).toJSON === "function"
    ? (value as { toJSON: (key: string) => unknown }).toJSON(key)
    : value;
}

function skipped(value: unknown): boolean {
  return value === undefined || typeof value === "function" ||
    typeof value === "symbol";
}

/** the pieces of JSON.stringify(value, null, 2), never joined into one string */
export function* prettyJsonChunks(value: unknown): Generator<string> {
  yield* chunksOf(viaToJSON(value, ""), "");
}

// toJSON is already applied, so a value it turns to undefined is skipped first
function* chunksOf(value: unknown, indent: string): Generator<string> {
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) {
      yield "[]";
      return;
    }
    yield "[\n";
    for (let i = 0; i < value.length; i++) {
      const item = viaToJSON(value[i], String(i));
      yield inner;
      if (skipped(item)) yield "null";
      else yield* chunksOf(item, inner);
      yield i < value.length - 1 ? ",\n" : "\n";
    }
    yield `${indent}]`;
    return;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, viaToJSON(v, k)] as const)
      .filter(([, v]) => !skipped(v));
    if (entries.length === 0) {
      yield "{}";
      return;
    }
    yield "{\n";
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      yield `${inner}${JSON.stringify(k)}: `;
      yield* chunksOf(v, inner);
      yield i < entries.length - 1 ? ",\n" : "\n";
    }
    yield `${indent}}`;
    return;
  }
  const text = JSON.stringify(value);
  if (text !== undefined) yield text;
}

/**
 * writes a `--json` value as JSON.stringify(value, null, 2) plus a newline, in
 * chunks, so a value too large for one string still prints
 */
export async function writeJsonValue(
  value: unknown,
  sink: Sink = (bytes) => Deno.stdout.write(bytes),
): Promise<void> {
  const encoder = new TextEncoder();
  const flush = async (text: string) => {
    const bytes = encoder.encode(text);
    let offset = 0;
    while (offset < bytes.length) {
      offset += await sink(bytes.subarray(offset));
    }
  };
  let pending: string[] = [];
  let pendingChars = 0;
  for (const chunk of prettyJsonChunks(value)) {
    pending.push(chunk);
    pendingChars += chunk.length;
    if (pendingChars >= FLUSH_CHARS) {
      await flush(pending.join(""));
      pending = [];
      pendingChars = 0;
    }
  }
  pending.push("\n");
  await flush(pending.join(""));
}
