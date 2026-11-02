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

export interface ArtifactRef {
  dataId: string;
  name: string;
  version: number;
  tags?: Record<string, string>;
}

export interface RunView {
  id: string;
  workflowName: string;
  workflowDataArtifacts?: ArtifactRef[];
}

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
 * markdown vs JSON is decided from the name the report is persisted under,
 * computed from its tags, not a -json suffix, which a report or variant name
 * could itself end in
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
 * the server can answer with another item of the same name, so anything but an
 * exact match to the recorded artifact is treated as superseded
 */
export function matchesRunRef(item: DataItem, ref: ArtifactRef): boolean {
  return item.version === ref.version && item.id === ref.dataId &&
    item.modelType === "workflow";
}

export function isRequestedReport(
  item: DataItem,
  reportName: string,
  variant?: string,
): boolean {
  if (item.tags.type !== "report" || item.tags.reportName !== reportName) {
    return false;
  }
  // An empty suffix means no variant, as in reportDataName and the links.
  return (item.tags.varySuffix || undefined) === (variant || undefined);
}

export function reportJsonName(item: DataItem): string | null {
  if (item.tags.type !== "report" || !item.tags.reportName) return null;
  if (!item.contentType.startsWith("text/markdown")) return null;
  const base = reportDataName(item.tags.reportName, item.tags.varySuffix);
  return item.name === base ? `${base}-json` : null;
}

const PAIR_WINDOW_MS = 60_000;

/**
 * the two items keep separate version counters and share no key, but the report
 * writes the JSON right after the markdown, so take the earliest JSON version
 * created at or after it, within a minute
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
 * serve keeps saying "Model" (it is protocol); the page says "Behavior", the
 * product term
 */
const ENTITY_LABELS: ReadonlyMap<string, string> = new Map([
  ["Workflow run or workflow", "Workflow run"],
  ["Model", "Behavior"],
]);

/**
 * `pinned` means the page asked for one exact version (a permalink or a run's
 * report): a missing item there has expired or been cleaned up, not renamed
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
    return { kind: "not-found", entity: ENTITY_LABELS.get(entity) ?? entity };
  }
  return { kind: "failed", message };
}

export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

export function documentTitle(item: string, context: string): string {
  return `${item} · ${context} · Swamp`;
}

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

export const RENDER_LIMIT = 256 * 1024;
