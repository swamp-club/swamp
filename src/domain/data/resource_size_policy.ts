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

import { UserError } from "../errors.ts";

// About twenty resources this size, parsed together at three times their size,
// fill a 4 GB heap.
export const DEFAULT_RESOURCE_WARN_BYTES = 64 * 1024 * 1024;

export type ResourceSizeVerdict = "ok" | "warn" | "refuse";

export interface ResourceSizeLimits {
  readonly warnBytes?: number;
  readonly maxBytes?: number;
}

function assertByteCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `resourceSize.${name} must be a positive whole number of bytes, got ${value}`,
    );
  }
}

/** an unset maxBytes refuses nothing, so a repo opts in to refusal */
export class ResourceSizePolicy {
  static readonly DEFAULT = new ResourceSizePolicy(
    DEFAULT_RESOURCE_WARN_BYTES,
    undefined,
  );

  private constructor(
    readonly warnBytes: number,
    readonly maxBytes: number | undefined,
  ) {}

  static create(limits: ResourceSizeLimits = {}): ResourceSizePolicy {
    const warnBytes = limits.warnBytes ?? DEFAULT_RESOURCE_WARN_BYTES;
    assertByteCount("warnBytes", warnBytes);
    if (limits.maxBytes !== undefined) {
      assertByteCount("maxBytes", limits.maxBytes);
      if (limits.maxBytes < warnBytes) {
        throw new RangeError(
          `resourceSize.maxBytes (${limits.maxBytes}) must be at least resourceSize.warnBytes (${warnBytes})`,
        );
      }
    }
    return new ResourceSizePolicy(warnBytes, limits.maxBytes);
  }

  classify(bytes: number): ResourceSizeVerdict {
    if (this.maxBytes !== undefined && bytes > this.maxBytes) return "refuse";
    if (bytes > this.warnBytes) return "warn";
    return "ok";
  }
}

export interface ResourceSizeConfigCheck {
  readonly policy: ResourceSizePolicy;
  /** each names a value that was ignored and why */
  readonly ignored: readonly string[];
  readonly unknownKeys: readonly string[];
}

const RESOURCE_SIZE_KEYS = new Set(["warnBytes", "maxBytes"]);

/** a bad value is ignored, never refused, so a typo cannot stop every run */
export function checkResourceSizeConfig(raw: unknown): ResourceSizeConfigCheck {
  if (raw === undefined || raw === null) {
    return { policy: ResourceSizePolicy.DEFAULT, ignored: [], unknownKeys: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      policy: ResourceSizePolicy.DEFAULT,
      ignored: ["resourceSize must be a mapping of warnBytes and maxBytes"],
      unknownKeys: [],
    };
  }
  const entries = raw as Record<string, unknown>;
  const ignored: string[] = [];
  const byteCount = (key: string): number | undefined => {
    const value = entries[key];
    if (value === undefined) return undefined;
    if (
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ) {
      return value;
    }
    ignored.push(
      `resourceSize.${key} must be a positive whole number of bytes, got ${
        JSON.stringify(value)
      }`,
    );
    return undefined;
  };
  const warnBytes = byteCount("warnBytes");
  let maxBytes = byteCount("maxBytes");
  const effectiveWarn = warnBytes ?? DEFAULT_RESOURCE_WARN_BYTES;
  if (maxBytes !== undefined && maxBytes < effectiveWarn) {
    ignored.push(
      `resourceSize.maxBytes (${maxBytes}) must be at least resourceSize.warnBytes (${effectiveWarn})`,
    );
    maxBytes = undefined;
  }
  return {
    policy: ResourceSizePolicy.create({ warnBytes, maxBytes }),
    ignored,
    unknownKeys: Object.keys(entries).filter((k) => !RESOURCE_SIZE_KEYS.has(k)),
  };
}

export function formatByteSize(bytes: number): string {
  const units = ["KiB", "MiB", "GiB"];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** the exact count, led by a binary unit once one is shorter */
export function describeByteCount(bytes: number): string {
  return bytes < 1024
    ? `${bytes} bytes`
    : `${formatByteSize(bytes)} (${bytes} bytes)`;
}

export interface WrittenResourceRef {
  readonly modelType: string;
  readonly definitionName?: string;
  readonly methodName?: string;
  readonly specName: string;
  readonly name: string;
}

export function describeWrittenResource(ref: WrittenResourceRef): string {
  const writer = ref.definitionName
    ? `${ref.definitionName}${ref.methodName ? `.${ref.methodName}` : ""}`
    : ref.modelType;
  return `resource ${ref.specName}/${ref.name} written by ${writer}`;
}

export class ResourceTooLargeError extends UserError {
  constructor(
    readonly resource: WrittenResourceRef,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Refused to write ${describeWrittenResource(resource)}: it is ${
        describeByteCount(bytes)
      }, past resourceSize.maxBytes of ${
        describeByteCount(maxBytes)
      } set in .swamp.yaml. ` +
        `Write less per resource (split it, or keep bulk content in a file), or raise resourceSize.maxBytes.`,
      "resource_too_large",
    );
    this.name = "ResourceTooLargeError";
  }
}
