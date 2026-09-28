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

import type { RouteState } from "../routes.ts";
import type { ArtifactRef } from "./data_target.ts";
import { reportDataName } from "./report_name.ts";

export interface ItemLink {
  label: string;
  /** Null when there is no page to link to; show the label as plain text. */
  to: RouteState | null;
}

/** A report's JSON half, which is shown through its markdown's page. */
function isReportJson(name: string, tags: Record<string, string>): boolean {
  return tags.type === "report" && !!tags.reportName &&
    name === `${reportDataName(tags.reportName, tags.varySuffix)}-json`;
}

function reportLabel(tags: Record<string, string>): string {
  return tags.varySuffix
    ? `${tags.reportName} · ${tags.varySuffix}`
    : tags.reportName;
}

/**
 * The link for an artifact a step wrote. Every model data item carries its
 * owner in `tags.modelName`, so step output links to that model's exact
 * version — unambiguous even when several steps write the same name (the
 * built-in method summary report runs on every step). Returns null for a
 * report's JSON half, which is reached from its markdown page.
 */
export function stepArtifactLink(ref: ArtifactRef): ItemLink | null {
  const tags = ref.tags ?? {};
  if (isReportJson(ref.name, tags)) return null;
  const isReport = tags.type === "report" && !!tags.reportName;
  const label = isReport ? reportLabel(tags) : `${ref.name} v${ref.version}`;
  const owner = tags.modelName;
  if (!owner || tags.reportScope === "workflow") return { label, to: null };
  return {
    label,
    to: {
      view: "models",
      detail: {
        kind: "data",
        modelName: owner,
        dataName: ref.name,
        version: ref.version,
      },
    },
  };
}

/** Links to a run's workflow-scope reports (one per report, markdown only). */
export function workflowReportLinks(
  refs: ArtifactRef[] | undefined,
  workflowName: string,
  runId: string,
): ItemLink[] {
  const links: ItemLink[] = [];
  for (const ref of refs ?? []) {
    const tags = ref.tags ?? {};
    if (tags.type !== "report" || !tags.reportName) continue;
    if (ref.name !== reportDataName(tags.reportName, tags.varySuffix)) continue;
    links.push({
      label: reportLabel(tags),
      to: {
        view: "workflows",
        detail: {
          kind: "runReport",
          workflowName,
          runId,
          reportName: tags.reportName,
        },
      },
    });
  }
  return links;
}

/** A row of `data.search` results. */
export interface SearchItem {
  name: string;
  modelName?: string;
  modelType?: string;
  contentType?: string;
  version?: number;
  tags?: Record<string, string>;
}

/**
 * The data page for a search row, or null when the row has no model page:
 * workflow-owned data, or a row whose owner name was never recorded.
 */
export function dataRowLink(row: SearchItem): RouteState | null {
  if (!row.modelName || row.modelType === "workflow") return null;
  return {
    view: "models",
    detail: { kind: "data", modelName: row.modelName, dataName: row.name },
  };
}

/** Splits a model's data into plain items and reports for its detail page. */
export function partitionModelData(
  modelName: string,
  rows: SearchItem[],
): { data: ItemLink[]; reports: ItemLink[] } {
  const data: ItemLink[] = [];
  const reports: ItemLink[] = [];
  for (const row of rows) {
    const tags = row.tags ?? {};
    if (isReportJson(row.name, tags)) continue;
    if (
      tags.type === "report" && tags.reportName &&
      row.name === reportDataName(tags.reportName, tags.varySuffix)
    ) {
      reports.push({
        label: reportLabel(tags),
        to: {
          view: "models",
          detail: {
            kind: "report",
            modelName,
            reportName: tags.reportName,
            ...(tags.varySuffix && { variant: tags.varySuffix }),
          },
        },
      });
      continue;
    }
    data.push({
      label: row.name,
      to: {
        view: "models",
        detail: { kind: "data", modelName, dataName: row.name },
      },
    });
  }
  const byLabel = (a: ItemLink, b: ItemLink) => a.label.localeCompare(b.label);
  return { data: data.sort(byLabel), reports: reports.sort(byLabel) };
}
