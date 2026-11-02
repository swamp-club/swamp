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

import { wordedError, wordedText } from "../behavior_wording.ts";

export class ModelType {
  private constructor(
    readonly raw: string,
    readonly normalized: string,
  ) {}

  static create(rawType: string): ModelType {
    if (typeof rawType !== "string") {
      throw new TypeError(
        `ModelType.create() expected a string but received ${typeof rawType}: ${
          String(rawType)
        }`,
      );
    }
    const trimmed = rawType.trim();
    if (trimmed.length === 0) {
      throw wordedError(wordedText((w) => `${w.Noun} type cannot be empty`));
    }

    const normalized = ModelType.normalize(trimmed);
    if (normalized.length === 0) {
      throw wordedError(
        wordedText((w) =>
          `${w.Noun} type normalization resulted in empty string`
        ),
      );
    }

    return new ModelType(trimmed, normalized);
  }

  private static normalize(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/::/g, "/")
      .replace(/\s+/g, "/")
      .replace(/\./g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/|\/$/g, "");
  }

  toNormalized(): string {
    return this.normalized;
  }

  toDirectoryPath(): string {
    return this.normalized;
  }

  equals(other: ModelType): boolean {
    return this.normalized === other.normalized;
  }

  toString(): string {
    return this.raw;
  }

  static isUserNamespace(normalized: string): boolean {
    return normalized.startsWith("@");
  }

  static getUserNamespace(normalized: string): string | undefined {
    if (!ModelType.isUserNamespace(normalized)) {
      return undefined;
    }
    const withoutAt = normalized.slice(1);
    const slashIndex = withoutAt.indexOf("/");
    if (slashIndex === -1) {
      return withoutAt;
    }
    return withoutAt.slice(0, slashIndex);
  }

  static getSegmentCount(normalized: string): number {
    if (ModelType.isUserNamespace(normalized)) {
      const withoutAt = normalized.slice(1);
      return withoutAt.split("/").filter((s) => s.length > 0).length;
    }
    return normalized.split("/").filter((s) => s.length > 0).length;
  }

  private static readonly RESERVED_COLLECTIVES = ["swamp", "si"];

  static isReservedCollective(normalized: string): boolean {
    if (ModelType.isUserNamespace(normalized)) {
      const namespace = ModelType.getUserNamespace(normalized);
      return namespace !== undefined &&
        ModelType.RESERVED_COLLECTIVES.includes(namespace);
    }
    const firstSlash = normalized.indexOf("/");
    const firstSegment = firstSlash === -1
      ? normalized
      : normalized.slice(0, firstSlash);
    return ModelType.RESERVED_COLLECTIVES.includes(firstSegment);
  }
}

export type ModelTypeInput = string | ModelType;

export function coerceModelType(input: ModelTypeInput): ModelType {
  if (input instanceof ModelType) return input;
  return ModelType.create(input);
}
