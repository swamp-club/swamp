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
import type { SearchItem } from "../views/artifact_links.ts";
import { reportDataName } from "../views/report_name.ts";
import { pluralize } from "../lib/format.ts";
import type {
  DiagramExtension,
  DiagramGroup,
  DiagramNode,
  DiagramSpec,
} from "./model_diagram_layout.ts";

// Turns serve's `model.get` result (plus the model's data, already fetched
// for the page) into the diagram's boxes. Serve's newer fields — declared
// data outputs, declared reports, the owning extension — are optional:
// older servers omit them, and each falls back to what the dashboard can
// work out itself.

/** Mirrors DataOutputSpecDescribeData in src/libswamp/types/schema_helpers.ts. */
export interface DataOutputSpec {
  specName: string;
  kind: "resource" | "file";
  description?: string;
  schema?: object;
  contentType?: string;
  lifetime?: string;
  garbageCollection?: number | string;
  streaming?: boolean;
  tags?: Record<string, string>;
}

/** Mirrors MethodDescribeData in src/libswamp/types/schema_helpers.ts. */
export interface MethodInfo {
  name: string;
  description?: string;
  arguments?: object;
}

/** Mirrors ModelGetData in src/libswamp/models/get.ts. */
export interface ModelInfo {
  id?: string;
  name: string;
  description?: string;
  type: string;
  version?: number;
  tags?: Record<string, string>;
  globalArguments?: Record<string, unknown>;
  globalArgumentsSchema?: object;
  methods?: MethodInfo[];
  typeVersion?: string;
  currentTypeVersion?: string;
  staleness?: string;
  dataOutputs?: DataOutputSpec[];
  reports?: Array<{ name: string; description?: string }>;
  extension?: { name: string; version?: string };
  definition?: string;
}

/** A `data.search` row with the fields the diagram reads. */
export interface ModelDataRow extends SearchItem {
  type?: string;
}

interface JsonSchemaLike {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: unknown[];
  oneOf?: unknown[];
  const?: unknown;
  description?: string;
  items?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
}

function asSchema(value: unknown): JsonSchemaLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonSchemaLike
    : null;
}

/** A short type for a JSON schema property: "string", "string[]", "enum". */
export function schemaTypeLabel(schema: unknown): string {
  const s = asSchema(schema);
  if (!s) return "any";
  if (Array.isArray(s.enum)) return "enum";
  if (s.const !== undefined) return "const";
  if (Array.isArray(s.type)) {
    return s.type.filter((t) => t !== "null").join(" | ") || "null";
  }
  if (s.type === "array") {
    const item = schemaTypeLabel(s.items);
    return item === "any" ? "array" : `${item}[]`;
  }
  if (typeof s.type === "string") return s.type;
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) return "union";
  return "any";
}

function valueTypeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * The extension that owns a type. Serve reports it when it knows; else a
 * scoped type's first two segments name it (`@acme/aws/ec2` → `@acme/aws`),
 * marked inferred. Built-in, unscoped types (`command/shell`) have none.
 */
export function modelExtension(
  model: Pick<ModelInfo, "type" | "extension">,
): DiagramExtension | null {
  if (model.extension?.name) {
    return {
      name: model.extension.name,
      version: model.extension.version,
      inferred: false,
    };
  }
  if (!model.type.startsWith("@")) return null;
  const parts = model.type.split("/");
  if (parts.length < 2 || parts[0].length < 2 || !parts[1]) return null;
  return { name: `${parts[0]}/${parts[1]}`, inferred: true };
}

function argumentNodes(model: ModelInfo): DiagramNode[] {
  const schema = asSchema(model.globalArgumentsSchema);
  const props = asSchema(schema?.properties) as
    | Record<string, unknown>
    | null;
  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.map(String) : [],
  );
  if (props && Object.keys(props).length > 0) {
    return Object.entries(props).map(([key, prop]) => ({
      id: `arg:${key}`,
      label: key,
      detail: `${schemaTypeLabel(prop)}${
        required.has(key) ? " · required" : ""
      }`,
      kind: "argument",
      to: null,
      description: asSchema(prop)?.description,
    }));
  }
  return Object.entries(model.globalArguments ?? {}).map(([key, value]) => ({
    id: `arg:${key}`,
    label: key,
    detail: valueTypeLabel(value),
    kind: "argument",
    to: null,
  }));
}

function methodNodes(model: ModelInfo): DiagramNode[] {
  return (model.methods ?? []).map((m) => {
    const props = asSchema(asSchema(m.arguments)?.properties);
    const args = props ? Object.keys(props) : [];
    return {
      id: `method:${m.name}`,
      label: `${m.name}()`,
      detail: args.length > 0 ? args.join(", ") : "no arguments",
      kind: "method",
      to: null,
      description: m.description,
    };
  });
}

function isReportRow(row: ModelDataRow): boolean {
  return row.tags?.type === "report" || row.type === "report";
}

function dataRoute(modelName: string, dataName: string): RouteState {
  return {
    view: "models",
    detail: { kind: "data", modelName, dataName },
  };
}

function byLabel(a: DiagramNode, b: DiagramNode): number {
  return a.label.localeCompare(b.label, undefined, { numeric: true });
}

function outputNodes(model: ModelInfo, rows: ModelDataRow[]): DiagramNode[] {
  const data = rows.filter((row) => !isReportRow(row));
  if (model.dataOutputs && model.dataOutputs.length > 0) {
    return model.dataOutputs.map((spec) => {
      const written = data
        .filter((row) =>
          row.tags?.specName === spec.specName || row.name === spec.specName
        )
        .map((row) => row.name)
        .sort();
      const parts: string[] = [spec.kind];
      if (spec.kind === "file" && spec.contentType) {
        parts.push(spec.contentType);
      }
      parts.push(
        written.length === 0
          ? "not written yet"
          : written.length === 1
          ? "written"
          : pluralize(written.length, "item"),
      );
      return {
        id: `spec:${spec.specName}`,
        label: spec.specName,
        detail: parts.join(" · "),
        kind: spec.kind,
        to: written.length > 0 ? dataRoute(model.name, written[0]) : null,
        description: spec.description,
      };
    });
  }
  const seen = new Set<string>();
  const nodes: DiagramNode[] = [];
  for (const row of data) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    const kind = row.type === "file"
      ? "file"
      : row.type === "resource"
      ? "resource"
      : "data";
    const parts = [row.type ?? "data"];
    if (row.contentType) parts.push(row.contentType);
    nodes.push({
      id: `data:${row.name}`,
      label: row.name,
      detail: parts.join(" · "),
      kind,
      to: dataRoute(model.name, row.name),
    });
  }
  return nodes.sort(byLabel);
}

function reportRoute(
  modelName: string,
  reportName: string,
  variant?: string,
): RouteState {
  return {
    view: "models",
    detail: {
      kind: "report",
      modelName,
      reportName,
      ...(variant && { variant }),
    },
  };
}

function reportNodes(model: ModelInfo, rows: ModelDataRow[]): DiagramNode[] {
  const nodes = new Map<string, DiagramNode>();
  for (const r of model.reports ?? []) {
    nodes.set(r.name, {
      id: `report:${r.name}`,
      label: r.name,
      detail: "not generated yet",
      kind: "report",
      to: reportRoute(model.name, r.name),
      description: r.description,
    });
  }
  for (const row of rows) {
    const tags = row.tags ?? {};
    if (tags.type !== "report" || !tags.reportName) continue;
    if (row.name !== reportDataName(tags.reportName, tags.varySuffix)) continue;
    const variant = tags.varySuffix || undefined;
    const key = variant
      ? `${tags.reportName}\u0000${variant}`
      : tags.reportName;
    const scope = tags.reportScope ? `${tags.reportScope} report` : "report";
    const declared = nodes.get(key);
    nodes.set(key, {
      id: `report:${key}`,
      label: variant ? `${tags.reportName} · ${variant}` : tags.reportName,
      detail: declared ? `${scope} · generated` : scope,
      kind: "report",
      to: reportRoute(model.name, tags.reportName, variant),
      description: declared?.description,
    });
  }
  return [...nodes.values()].sort(byLabel);
}

function placeholder(id: string, label: string): DiagramNode {
  return { id, label, kind: "placeholder", to: null };
}

const STALE_LABELS: Record<string, string> = {
  upgradable: "upgrade available",
  stranded: "type missing",
  invalid: "invalid",
};

/** Builds the diagram for a model and its data rows. */
export function buildDiagramSpec(
  model: ModelInfo,
  rows: readonly ModelDataRow[],
): DiagramSpec {
  const list = [...rows];
  const args = argumentNodes(model);
  const methods = methodNodes(model);
  const outputs = outputNodes(model, list);
  const reports = reportNodes(model, list);

  const groups: DiagramGroup[] = [];
  if (args.length > 0 || methods.length === 0) {
    groups.push({
      key: "arguments",
      title: "Arguments",
      side: "in",
      nodes: args.length > 0 ? args : [placeholder("none", "No arguments")],
    });
  }
  if (methods.length > 0) {
    groups.push({
      key: "methods",
      title: "Methods",
      side: "in",
      nodes: methods,
    });
  }
  groups.push({
    key: "outputs",
    title: "Outputs",
    side: "out",
    nodes: outputs.length > 0
      ? outputs
      : [placeholder("none", "No outputs yet")],
  });
  if (reports.length > 0) {
    groups.push({
      key: "reports",
      title: "Reports",
      side: "out",
      nodes: reports,
    });
  }

  const summary = methods.length > 0
    ? pluralize(methods.length, "method")
    : undefined;
  return {
    model: {
      name: model.name,
      type: model.type,
      version: model.version,
      stale: model.staleness ? STALE_LABELS[model.staleness] : undefined,
      summary,
    },
    groups,
    extension: modelExtension(model),
  };
}

const VERBS: Record<DiagramGroup["key"], string> = {
  arguments: "Takes",
  methods: "Offers",
  outputs: "Writes",
  reports: "Generates",
};

/** One sentence per side, for screen readers and the text alternative. */
export function describeDiagram(spec: DiagramSpec): string {
  const listOf = (nodes: DiagramNode[]) =>
    nodes.filter((n) => n.kind !== "placeholder").map((n) => n.label);
  const sentences: string[] = [];
  const ext = spec.extension
    ? ` from extension ${spec.extension.name}${
      spec.extension.inferred ? " (inferred from its type)" : ""
    }`
    : "";
  sentences.push(`Model ${spec.model.name} of type ${spec.model.type}${ext}.`);
  for (const g of spec.groups) {
    const names = listOf(g.nodes);
    const verb = VERBS[g.key];
    if (names.length === 0) {
      sentences.push(`No ${g.title.toLowerCase()}.`);
    } else {
      sentences.push(
        `${verb} ${
          pluralize(names.length, g.title.toLowerCase().replace(/s$/, ""))
        }: ${names.join(", ")}.`,
      );
    }
  }
  return sentences.join(" ");
}
