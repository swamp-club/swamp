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

import { useRequest } from "../client/useRequest";
import { extractArray, extractObject } from "../client/extract";
import { CodeBlock } from "../components/CodeBlock";
import { RouteLink } from "../components/RouteLink";
import {
  type ItemLink,
  partitionModelData,
  type SearchItem,
} from "./artifact_links.ts";
import * as yaml from "js-yaml";

interface ModelDetailProps {
  modelName: string;
  onBack: () => void;
}

interface ModelData {
  name: string;
  type: string;
  id: string;
  version?: number;
  tags?: Record<string, string>;
  globalArguments?: Record<string, unknown>;
  methods?: Record<string, unknown>;
  definition?: string;
  [key: string]: unknown;
}

export function ModelDetail({ modelName, onBack }: ModelDetailProps) {
  const { data, loading, error } = useRequest("model.get", {
    modelIdOrName: modelName,
  });

  const model = extractObject<ModelData>(data);
  const { data: searchData } = useRequest("data.search", {
    model: modelName,
    limit: 1000,
  });
  const { data: items, reports } = partitionModelData(
    modelName,
    extractArray<SearchItem>(searchData),
  );

  return (
    <>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              border: "1px solid var(--border)",
              background: "var(--surface)",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              color: "var(--text-2)",
              fontFamily: "inherit",
              fontSize: "0.82rem",
            }}
          >
            &larr; Back
          </button>
          <h1>{modelName}</h1>
        </div>
        {model && (
          <div className="header-right">
            <span
              className="mono"
              style={{ fontSize: "0.78rem", color: "var(--text-3)" }}
            >
              {model.type}
            </span>
          </div>
        )}
      </div>

      {loading && <div className="loading">Loading model...</div>}
      {error && (
        <div className="loading" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {(reports.length > 0 || items.length > 0) && (
        <div className="panels-grid" style={{ marginBottom: 16 }}>
          <LinkPanel title="Reports" links={reports} />
          <LinkPanel title="Data" links={items} />
        </div>
      )}

      {model && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Definition</div>
            <span className="panel-count">{model.type}</span>
          </div>
          <CodeBlock
            code={model.definition ??
              yaml.dump(model, { lineWidth: -1, noRefs: true })}
            language="yaml"
          />
        </div>
      )}
    </>
  );
}

function LinkPanel({ title, links }: { title: string; links: ItemLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">{title}</div>
        <span className="panel-count">{links.length}</span>
      </div>
      <ul className="version-list">
        {links.map((link) => (
          <li key={link.label}>
            {link.to
              ? <RouteLink to={link.to}>{link.label}</RouteLink>
              : link.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
