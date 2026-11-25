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

import { getHeapStatistics } from "node:v8";
import { getLogger } from "@logtape/logtape";
import { UserError } from "../errors.ts";
import { escapeLogTemplate } from "../../infrastructure/logging/logger.ts";
import {
  DEFAULT_RESOURCE_WARN_BYTES,
  describeByteCount,
} from "./resource_size_policy.ts";

const logger = getLogger(["swamp", "data", "resource-size"]);

export interface HeapProbe {
  heapLimitBytes(): number;
  heapUsedBytes(): number;
}

export const v8HeapProbe: HeapProbe = {
  heapLimitBytes: () => getHeapStatistics().heap_size_limit,
  heapUsedBytes: () => Deno.memoryUsage().heapUsed,
};

// decoding holds one copy of the text and JSON.parse builds one to two more
export const DECODED_HEAP_FACTOR = 3;

// V8's sizes: an object with four in-object slots, an array, a slot per element or extra member
const PARSED_OBJECT_BYTES = 56;
const PARSED_OBJECT_INLINE_MEMBERS = 4;
const PARSED_ARRAY_BYTES = 48;
const PARSED_SLOT_BYTES = 8;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

const IS_ARRAY = 1;
const HOLDS = 2;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/**
 * the parse's heap from containers alone; strings are skipped, as V8 shares
 * keys and repeated values; past cap it stops and returns a figure over cap
 */
export function estimateParsedJsonBytes(
  content: Uint8Array,
  cap: number = Number.POSITIVE_INFINITY,
): number {
  let total = 0;
  let inString = false;
  let escaped = false;
  // per open container, in typed arrays so deep nesting grows no V8 heap:
  // bit 0 marks an array, bit 1 a container holding anything
  let flags = new Uint8Array(64);
  let commas = new Uint32Array(64);
  let depth = 0;
  // JSON.parse builds at most the first value before failing on what follows
  // TextDecoder drops a leading byte-order mark before the parse sees the text
  let start = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
    ? 3
    : 0;
  while (start < content.length && isJsonWhitespace(content[start])) start++;
  if (content[start] !== OPEN_OBJECT && content[start] !== OPEN_ARRAY) return 0;
  for (let i = start; i < content.length; i++) {
    const byte = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === BACKSLASH) escaped = true;
      else if (byte === QUOTE) inString = false;
      continue;
    }
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      if (depth > 0) flags[depth - 1] |= HOLDS;
      if (depth === flags.length) {
        const grownFlags = new Uint8Array(depth * 2);
        grownFlags.set(flags);
        flags = grownFlags;
        const grownCommas = new Uint32Array(depth * 2);
        grownCommas.set(commas);
        commas = grownCommas;
      }
      flags[depth] = byte === OPEN_ARRAY ? IS_ARRAY : 0;
      commas[depth] = 0;
      depth++;
      // every open container costs at least an array once closed
      if (total + depth * PARSED_ARRAY_BYTES > cap) {
        return total + depth * PARSED_ARRAY_BYTES;
      }
    } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      if (depth === 0) continue;
      depth--;
      const items = flags[depth] & HOLDS ? commas[depth] + 1 : 0;
      total += flags[depth] & IS_ARRAY
        ? PARSED_ARRAY_BYTES + PARSED_SLOT_BYTES * items
        : PARSED_OBJECT_BYTES +
          PARSED_SLOT_BYTES *
            Math.max(0, items - PARSED_OBJECT_INLINE_MEMBERS);
      if (total > cap || depth === 0) return total;
    } else if (byte === COMMA) {
      if (depth > 0) commas[depth - 1]++;
    } else if (byte === QUOTE) {
      inString = true;
      if (depth > 0) flags[depth - 1] |= HOLDS;
    } else if (byte !== COLON && !isJsonWhitespace(byte) && depth > 0) {
      flags[depth - 1] |= HOLDS;
    }
  }
  return total;
}

export interface LoadedItemRef {
  readonly modelType: string;
  readonly modelName?: string;
  readonly dataName: string;
  /** absent when the read took the latest version without naming it */
  readonly version?: number;
}

export function describeLoadedItem(item: LoadedItemRef): string {
  const owner = item.modelName ? item.modelName : item.modelType;
  const version = item.version === undefined ? "" : `@v${item.version}`;
  return `${owner}/${item.dataName}${version}`;
}

/** TextDecoder refuses more bytes than V8's maximum string length */
export const MAX_DECODABLE_BYTES = 2 ** 29 - 24;

export type TooLargeToLoadReason = "memory" | "text-length";

/** recorded on an item a reader left unloaded, so the read that needs it fails */
export interface TooLargeToLoad {
  readonly bytes: number;
  readonly reason: TooLargeToLoadReason;
}

/** the marker as stored data carries it; anything malformed is no marker */
export function parseTooLargeToLoad(
  value: unknown,
): TooLargeToLoad | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { bytes, reason } = value as Record<string, unknown>;
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
  if (reason !== "memory" && reason !== "text-length") return undefined;
  return { bytes, reason };
}

function tooLargeExplanation(reason: TooLargeToLoadReason): string {
  return reason === "text-length"
    ? "more than swamp can load as text"
    : "and loading it would exhaust the memory left to this process";
}

/** names the item and its size only: serve relays it to remote callers */
export class ResourceTooLargeToLoadError extends UserError {
  constructor(
    readonly item: LoadedItemRef,
    readonly bytes: number,
    readonly reason: TooLargeToLoadReason = "memory",
  ) {
    super(
      `Cannot load ${describeLoadedItem(item)}: it is ${
        describeByteCount(bytes)
      }, ${tooLargeExplanation(reason)}. ` +
        `List the largest data items without loading them with: ` +
        `swamp data query 'size > ${DEFAULT_RESOURCE_WARN_BYTES}' --select '{"model": modelName, "name": name, "version": version, "size": size}' --sort size:desc --limit 20`,
      "resource_too_large_to_load",
    );
    this.name = "ResourceTooLargeToLoadError";
  }
}

/**
 * heapUsed counts garbage not yet collected, so an item near the limit can be
 * refused that V8 would have fit; the floor keeps small reads out of that
 */
export class ResourceLoadGuard {
  constructor(
    private readonly probe: HeapProbe = v8HeapProbe,
    readonly floorBytes: number = DEFAULT_RESOURCE_WARN_BYTES,
    readonly maxDecodableBytes: number = MAX_DECODABLE_BYTES,
  ) {}

  assertLoadable(item: LoadedItemRef, bytes: number): void {
    const refusal = this.#memoryRefusal(item, bytes);
    if (refusal) throw refusal;
  }

  /** assertLoadable for content in hand that will be parsed as JSON */
  assertParsable(item: LoadedItemRef, content: Uint8Array): void {
    const refusal = this.#memoryRefusal(item, content.length, content);
    if (refusal) throw refusal;
  }

  /**
   * the heap check plus the text-length limit, for callers that record a
   * refusal; heldBytes, earlier items the read still holds, counts toward the
   * floor only, since the heap in use already includes them
   */
  refusalFor(
    item: LoadedItemRef,
    bytes: number,
    heldBytes = 0,
  ): ResourceTooLargeToLoadError | undefined {
    if (bytes > this.maxDecodableBytes) {
      return new ResourceTooLargeToLoadError(item, bytes, "text-length");
    }
    return this.#memoryRefusal(item, bytes, undefined, heldBytes);
  }

  /** refusalFor for content in hand that will be parsed as JSON */
  parseRefusalFor(
    item: LoadedItemRef,
    content: Uint8Array,
    heldBytes = 0,
  ): ResourceTooLargeToLoadError | undefined {
    if (content.length > this.maxDecodableBytes) {
      return new ResourceTooLargeToLoadError(
        item,
        content.length,
        "text-length",
      );
    }
    return this.#memoryRefusal(item, content.length, content, heldBytes);
  }

  #memoryRefusal(
    item: LoadedItemRef,
    bytes: number,
    parsed?: Uint8Array,
    heldBytes = 0,
  ): ResourceTooLargeToLoadError | undefined {
    if (!(bytes + heldBytes >= this.floorBytes)) return undefined;
    const limit = this.probe.heapLimitBytes();
    const used = this.probe.heapUsedBytes();
    let needed = bytes * DECODED_HEAP_FACTOR;
    // the scan runs only when the cheaper byte estimate would admit the item
    if (parsed !== undefined && used + needed <= limit) {
      needed = Math.max(
        needed,
        bytes + estimateParsedJsonBytes(parsed, limit - used - bytes),
      );
    }
    if (used + needed <= limit) return undefined;
    logger.warn(escapeLogTemplate(
      `Refused to load ${
        describeLoadedItem(item)
      } of ${bytes} bytes: about ${needed} bytes needed, ${used} of ${limit} heap bytes in use`,
    ));
    return new ResourceTooLargeToLoadError(item, bytes);
  }
}

export const defaultResourceLoadGuard = new ResourceLoadGuard();

export function resourceLoadGuardOf(
  holder: { readonly loadGuard?: ResourceLoadGuard } | undefined,
): ResourceLoadGuard {
  return holder?.loadGuard ?? defaultResourceLoadGuard;
}
