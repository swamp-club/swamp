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

/** Largest item whose content the dashboard fetches and renders inline. */
export const CONTENT_DISPLAY_CAP_BYTES = 1_000_000;

export type ContentKind = "json" | "yaml" | "markdown" | "text" | "binary";

/**
 * How the view should treat an item's content:
 * - `auto`: fetch and render it
 * - `onDemand`: the size is unknown; fetch only when the user asks
 * - `never`: binary or over the cap; show the size only
 */
export type ContentFetch = "auto" | "onDemand" | "never";

export interface ContentPlan {
  kind: ContentKind;
  fetch: ContentFetch;
}

/** Classifies a MIME type by how the dashboard can render it. */
export function contentKindFor(contentType: string | undefined): ContentKind {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (
    mime === "application/yaml" || mime === "application/x-yaml" ||
    mime === "text/yaml" || mime === "text/x-yaml"
  ) return "yaml";
  if (mime === "text/markdown" || mime === "text/x-markdown") {
    return "markdown";
  }
  if (
    mime.startsWith("text/") || mime === "application/xml" ||
    mime.endsWith("+xml")
  ) return "text";
  return "binary";
}

/** Decides whether to fetch content from its type and recorded size. */
export function contentPlanFor(
  contentType: string | undefined,
  size: number | undefined,
): ContentPlan {
  const kind = contentKindFor(contentType);
  if (kind === "binary") return { kind, fetch: "never" };
  if (size === undefined) return { kind, fetch: "onDemand" };
  if (size > CONTENT_DISPLAY_CAP_BYTES) return { kind, fetch: "never" };
  return { kind, fetch: "auto" };
}

/** Pretty-prints JSON, returning the input unchanged when it does not parse. */
export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Formats a byte count for display, e.g. `1.5 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
