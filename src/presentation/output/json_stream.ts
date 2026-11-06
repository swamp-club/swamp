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

type Container =
  | { kind: "array"; items: unknown[]; indent: string; next: number }
  | {
    kind: "object";
    entries: (readonly [string, unknown])[];
    indent: string;
    next: number;
  };

// toJSON is already applied to value; an object's entries take theirs here
function containerOf(value: unknown, indent: string): Container | undefined {
  if (Array.isArray(value)) {
    return { kind: "array", items: value, indent, next: 0 };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const entries = Object.entries(value)
    .map(([k, v]) => [k, viaToJSON(v, k)] as const)
    .filter(([, v]) => !skipped(v));
  return { kind: "object", entries, indent, next: 0 };
}

function sizeOf(container: Container): number {
  return container.kind === "array"
    ? container.items.length
    : container.entries.length;
}

/**
 * the pieces of JSON.stringify(value, null, 2), never joined into one string;
 * walks an explicit stack, so depth is no limit
 */
export function* prettyJsonChunks(value: unknown): Generator<string> {
  const open: Container[] = [];
  let current = viaToJSON(value, "");
  let indent = "";
  while (true) {
    const container = containerOf(current, indent);
    if (container === undefined) {
      const text = JSON.stringify(current);
      if (text !== undefined) yield text;
    } else if (sizeOf(container) === 0) {
      yield container.kind === "array" ? "[]" : "{}";
    } else {
      yield container.kind === "array" ? "[\n" : "{\n";
      open.push(container);
    }

    let parent = open[open.length - 1];
    while (parent !== undefined && parent.next === sizeOf(parent)) {
      yield `\n${parent.indent}${parent.kind === "array" ? "]" : "}"}`;
      open.pop();
      parent = open[open.length - 1];
    }
    if (parent === undefined) return;

    const i = parent.next++;
    indent = parent.indent + "  ";
    yield i > 0 ? `,\n${indent}` : indent;
    if (parent.kind === "array") {
      const item = viaToJSON(parent.items[i], String(i));
      current = skipped(item) ? null : item;
    } else {
      const [k, v] = parent.entries[i];
      yield `${JSON.stringify(k)}: `;
      current = v;
    }
  }
}

/** JSON.stringify(value, null, 2) with no depth limit, still as one string */
export function prettyJson(value: unknown): string {
  return [...prettyJsonChunks(value)].join("");
}

/**
 * writes a `--json` value as JSON.stringify(value, null, 2) plus a newline, in
 * chunks, so a value too large for one string still prints; a reader that
 * closes the pipe early ends the write quietly, as it does for console.log
 */
export async function writeJsonValue(
  value: unknown,
  sink: Sink = (bytes) => Deno.stdout.write(bytes),
): Promise<void> {
  const encoder = new TextEncoder();
  const flush = async (text: string): Promise<boolean> => {
    const bytes = encoder.encode(text);
    let offset = 0;
    try {
      while (offset < bytes.length) {
        offset += await sink(bytes.subarray(offset));
      }
    } catch (error) {
      if (error instanceof Deno.errors.BrokenPipe) return false;
      throw error;
    }
    return true;
  };
  let pending: string[] = [];
  let pendingChars = 0;
  for (const chunk of prettyJsonChunks(value)) {
    pending.push(chunk);
    pendingChars += chunk.length;
    if (pendingChars >= FLUSH_CHARS) {
      if (!await flush(pending.join(""))) return;
      pending = [];
      pendingChars = 0;
    }
  }
  pending.push("\n");
  await flush(pending.join(""));
}
