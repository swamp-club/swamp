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

import {
  DELEGATED_ACTIONS,
  FORWARDED_READS,
  notAvailableLocally,
} from "./local/local_actions.ts";
import { HTTP_REQUEST_TYPES } from "./protocol.ts";

/** cli callers hold a serve token; page callers are dashboard tabs a hub vouched for */
export type CallerClass = "cli" | "page";

export const CALLER_CLASSES: readonly CallerClass[] = ["cli", "page"];

export function isCallerClass(value: unknown): value is CallerClass {
  return value === "cli" || value === "page";
}

/** what a dashboard tab may send: its reads, its four actions, and cancel */
export const PAGE_OPERATIONS: readonly string[] = [
  ...FORWARDED_READS,
  ...DELEGATED_ACTIONS,
  "cancel",
].sort();

/** page reads a tab may also send over the HTTP request route */
export const PAGE_HTTP_OPERATIONS: readonly string[] = [...FORWARDED_READS]
  .filter((type) => HTTP_REQUEST_TYPES.has(type))
  .sort();

export class CallerClassPolicy {
  readonly #operations: ReadonlySet<string>;
  private constructor(
    readonly callerClass: CallerClass,
    operations: Iterable<string>,
  ) {
    this.#operations = new Set(operations);
  }
  static cli(operations: Iterable<string>): CallerClassPolicy {
    return new CallerClassPolicy("cli", operations);
  }
  static page(): CallerClassPolicy {
    return new CallerClassPolicy("page", PAGE_OPERATIONS);
  }
  allows(type: string): boolean {
    return this.#operations.has(type);
  }
}

/** the refusal swamp-uat pins for anything a dashboard tab may not send */
export function pageRefusal(
  id: string,
  type: string,
): ReturnType<typeof notAvailableLocally> {
  return notAvailableLocally(id, type);
}
