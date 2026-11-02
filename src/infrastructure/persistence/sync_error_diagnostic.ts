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
 * duck-typed because extensions throw arbitrary values, including opaque SDK
 * errors; extracts standard metadata fields without depending on any SDK
 */

export type SyncOperation = "pull" | "push";

const MESSAGE_PREVIEW_LIMIT = 2000;

export interface SyncErrorSummary {
  summary: string;
  /**
   * only keys that could be extracted are included; missing fields are absent,
   * not 'undefined' strings
   */
  fields: Record<string, string | number>;
}

/**
 * must not throw on proxies, non-objects or exotic getters; returns undefined
 * if the read is unsafe
 */
function readProp(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function truncate(message: string): string {
  return message.length <= MESSAGE_PREVIEW_LIMIT
    ? message
    : message.slice(0, MESSAGE_PREVIEW_LIMIT) + "…";
}

export function summarizeSyncError(
  operation: SyncOperation,
  label: string,
  error: unknown,
): SyncErrorSummary {
  const fields: Record<string, string | number> = { operation, label };

  const metadata = readProp(error, "$metadata");
  const httpStatusCode = coerceNumber(readProp(metadata, "httpStatusCode"));
  const requestId = coerceString(readProp(metadata, "requestId"));
  const code = coerceString(readProp(error, "Code")) ??
    coerceString(readProp(error, "code"));
  const name = coerceString(readProp(error, "name"));
  const rawMessage = coerceString(readProp(error, "message")) ??
    (typeof error === "string" ? error : undefined) ??
    (typeof error === "number" ? String(error) : undefined);

  if (httpStatusCode !== undefined) fields.httpStatusCode = httpStatusCode;
  if (requestId) fields.requestId = requestId;
  if (code) fields.code = code;
  if (name) fields.name = name;
  // Exposed as `errorMessage` (not `message`) so that when `fields` is
  // spread into LogTape calls the entry doesn't collide with LogTape's
  // reserved `message` property on the log record.
  if (rawMessage) fields.errorMessage = rawMessage;

  const detailParts: string[] = [];
  if (httpStatusCode !== undefined) detailParts.push(`HTTP ${httpStatusCode}`);
  if (requestId) detailParts.push(`requestId=${requestId}`);
  if (code) detailParts.push(`code=${code}`);
  const details = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";

  // Collapse any whitespace runs containing newlines so the rendered
  // summary stays single-line. The full, unmodified message remains
  // available on `fields.errorMessage` for consumers that want fidelity.
  const singleLineMessage = rawMessage?.replace(/\s*\n+\s*/g, " ").trim();

  const trailer = singleLineMessage && singleLineMessage !== name
    ? `: ${truncate(singleLineMessage)}`
    : name
    ? `: ${name}`
    : "";

  const summary = `${label} ${operation} failed${details}${trailer}`;
  return { summary, fields };
}

const AUTHORIZATION_CODES = new Set([
  "AccessDenied",
  "Forbidden",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "Unauthorized",
]);

const CAUSE_DEPTH = 5;

/**
 * duck-typed since extensions throw their own error classes; core rewraps some
 * errors by message alone, so a message naming HTTP 401 or 403 or rejected
 * credentials counts too
 */
export function isDatastoreAuthorizationError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth <= CAUSE_DEPTH; depth++) {
    if (current === null || current === undefined) return false;
    const status = coerceNumber(readProp(current, "httpStatusCode")) ??
      coerceNumber(
        readProp(readProp(current, "$metadata"), "httpStatusCode"),
      ) ??
      coerceNumber(readProp(current, "status")) ??
      coerceNumber(readProp(current, "code"));
    if (status === 401 || status === 403) return true;
    for (const key of ["Code", "code", "name"]) {
      const code = coerceString(readProp(current, key));
      if (code !== undefined && AUTHORIZATION_CODES.has(code)) return true;
    }
    const message = coerceString(readProp(current, "message")) ??
      (typeof current === "string" ? current : undefined);
    if (
      message !== undefined &&
      (/\bHTTP 40[13]\b/.test(message) ||
        /credentials rejected/i.test(message))
    ) {
      return true;
    }
    current = readProp(current, "cause");
  }
  return false;
}
