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

/** names the item and its size only: serve relays it to remote callers */
export class ResourceTooLargeToLoadError extends UserError {
  constructor(readonly item: LoadedItemRef, readonly bytes: number) {
    super(
      `Cannot load ${describeLoadedItem(item)}: it is ${
        describeByteCount(bytes)
      }, and loading it would exhaust the memory left to this process. ` +
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
  ) {}

  assertLoadable(item: LoadedItemRef, bytes: number): void {
    if (!(bytes >= this.floorBytes)) return;
    const limit = this.probe.heapLimitBytes();
    const used = this.probe.heapUsedBytes();
    const needed = bytes * DECODED_HEAP_FACTOR;
    if (used + needed <= limit) return;
    logger.warn(escapeLogTemplate(
      `Refused to load ${
        describeLoadedItem(item)
      } of ${bytes} bytes: about ${needed} bytes needed, ${used} of ${limit} heap bytes in use`,
    ));
    throw new ResourceTooLargeToLoadError(item, bytes);
  }
}

export const defaultResourceLoadGuard = new ResourceLoadGuard();

export function resourceLoadGuardOf(
  holder: { readonly loadGuard?: ResourceLoadGuard } | undefined,
): ResourceLoadGuard {
  return holder?.loadGuard ?? defaultResourceLoadGuard;
}
