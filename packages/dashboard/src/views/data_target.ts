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

import type { RequestErrorInfo } from "../client/stream.ts";
import { reportDataName } from "./report_name.ts";

/** A data artifact reference as recorded on a workflow run. */
export interface ArtifactRef {
  dataId: string;
  name: string;
  version: number;
  tags?: Record<string, string>;
}

/** The parts of a `workflow.history.get` run this page reads. */
export interface RunView {
  id: string;
  workflowName: string;
  workflowDataArtifacts?: ArtifactRef[];
}

/** The parts of a `data.get` result this page reads. */
export interface DataItem {
  id: string;
  name: string;
  modelName: string;
  modelType: string;
  version: number;
  contentType: string;
  lifetime?: string;
  garbageCollection?: number;
  tags: Record<string, string>;
  createdAt: string;
  size?: number;
  checksum?: string;
  content?: string;
  contentEncoding?: "utf-8" | "base64";
}

export interface VersionInfo {
  version: number;
  createdAt: string;
  isLatest: boolean;
}

export type RunReportRefs =
  | { status: "ok"; markdown: ArtifactRef; json?: ArtifactRef }
  | { status: "wrong-workflow" }
  | { status: "missing" };

/**
 * Finds a workflow-scope report's markdown and JSON artifacts on a run.
 * Markdown vs JSON is decided from the name the report is persisted under,
 * computed from its tags — not by a `-json` suffix, which a report or
 * variant name could itself end in.
 */
export function resolveRunReportRefs(
  run: RunView,
  workflowName: string,
  reportName: string,
): RunReportRefs {
  // history.get finds a run by id across every workflow; an edited link must
  // not show another workflow's run under this workflow's name.
  if (run.workflowName !== workflowName) return { status: "wrong-workflow" };
  const refs = (run.workflowDataArtifacts ?? []).filter((ref) =>
    ref.tags?.type === "report" && ref.tags.reportName === reportName
  );
  const base = reportDataName(reportName);
  const markdown = refs.find((ref) => ref.name === base);
  if (!markdown) return { status: "missing" };
  const json = refs.find((ref) => ref.name === `${base}-json`);
  return { status: "ok", markdown, ...(json && { json }) };
}

/**
 * True when the item served for a run's report is exactly the artifact the
 * run recorded. Until run-scoped lookups resolve older versions
 * (swamp-club#2601) the server can answer with another item of the same
 * name; anything but an exact match is treated as superseded.
 */
export function matchesRunRef(item: DataItem, ref: ArtifactRef): boolean {
  return item.version === ref.version && item.id === ref.dataId &&
    item.modelType === "workflow";
}

/** True when a model-scoped item is the named report (and variant). */
export function isRequestedReport(
  item: DataItem,
  reportName: string,
  variant?: string,
): boolean {
  if (item.tags.type !== "report" || item.tags.reportName !== reportName) {
    return false;
  }
  return variant === undefined
    ? item.tags.varySuffix === undefined
    : item.tags.varySuffix === variant;
}

/** The JSON sibling of a report's markdown item, when it is a report. */
export function reportJsonName(item: DataItem): string | null {
  if (item.tags.type !== "report" || !item.tags.reportName) return null;
  if (!item.contentType.startsWith("text/markdown")) return null;
  const base = reportDataName(item.tags.reportName, item.tags.varySuffix);
  return item.name === base ? `${base}-json` : null;
}

const PAIR_WINDOW_MS = 60_000;

/**
 * Picks the JSON version written with a markdown version. The two items
 * keep separate version counters and share no key, but the report writes
 * the JSON straight after the markdown, so take the earliest JSON version
 * created at or after it, within a minute.
 */
export function pairJsonVersion(
  markdownCreatedAt: string,
  jsonVersions: VersionInfo[],
): number | null {
  const start = Date.parse(markdownCreatedAt);
  if (Number.isNaN(start)) return null;
  let best: { version: number; delta: number } | null = null;
  for (const candidate of jsonVersions) {
    const delta = Date.parse(candidate.createdAt) - start;
    if (Number.isNaN(delta) || delta < 0 || delta > PAIR_WINDOW_MS) continue;
    if (!best || delta < best.delta) {
      best = { version: candidate.version, delta };
    }
  }
  return best?.version ?? null;
}

/** The newest version number, from a newest-first `data.versions` list. */
export function latestVersion(versions: VersionInfo[]): number | null {
  const latest = versions.find((v) => v.isLatest) ?? versions[0];
  return latest?.version ?? null;
}

export type ContentKind = "markdown" | "json" | "yaml" | "text" | "binary";

export function contentKind(
  contentType: string,
  encoding: string | undefined,
): ContentKind {
  if (encoding === "base64") return "binary";
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "text/markdown") return "markdown";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (
    type === "application/yaml" || type === "application/x-yaml" ||
    type === "text/yaml"
  ) {
    return "yaml";
  }
  return "text";
}

/** Pretty-prints JSON content; leaves invalid JSON as it is. */
export function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export type PageError =
  | { kind: "denied" }
  | { kind: "gone" }
  | { kind: "superseded" }
  | { kind: "not-found"; entity: string }
  | { kind: "pending" }
  | { kind: "failed"; message: string };

const DENIED_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "access_not_configured",
]);

/**
 * What to tell the reader when a request failed. `pinned` is true when the
 * page asked for one exact version (a permalink or a run's report): a
 * missing item there has expired or been cleaned up, not merely renamed.
 */
export function pageError(
  message: string | null,
  info: RequestErrorInfo | null,
  pinned: boolean,
): PageError | null {
  if (message === null) return null;
  if (info && DENIED_CODES.has(info.code)) return { kind: "denied" };
  if (info?.reason === "data_pending") return { kind: "pending" };
  if (info?.reason === "not_found") {
    const entity = info.entityType ?? "Data";
    if (entity === "Data") {
      return pinned ? { kind: "gone" } : { kind: "not-found", entity };
    }
    return {
      kind: "not-found",
      entity: entity === "Workflow run or workflow" ? "Workflow run" : entity,
    };
  }
  return { kind: "failed", message };
}

/** A short run id for breadcrumbs and titles. */
export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

/** The browser tab title for an item. */
export function documentTitle(item: string, context: string): string {
  return `${item} · ${context} · Swamp`;
}

/** The raw bytes to download for an item's content. */
export function contentBytes(
  content: string,
  encoding: string | undefined,
): Uint8Array {
  if (encoding === "base64") {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(content);
}

/** Content past this many characters is shown truncated until expanded. */
export const RENDER_LIMIT = 256 * 1024;
