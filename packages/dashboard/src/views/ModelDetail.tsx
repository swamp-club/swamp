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

import * as yaml from "js-yaml";
import { useMemo } from "react";
import { useRequest } from "../client/useRequest.ts";
import { extractArray, extractObject } from "../client/extract.ts";
import {
  describeTimeRange,
  useTimeBounds,
  useTimeRange,
} from "../client/time_range.ts";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ModelDiagram } from "../components/ModelDiagram.tsx";
import { navigateTo } from "../hooks/useRouter.ts";
import { ModelDiagramSkeleton } from "../components/ModelDiagramSkeleton.tsx";
import {
  buildDiagramSpec,
  type ModelDataRow,
  type ModelInfo,
} from "../components/model_diagram_spec.ts";
import { RouteLink } from "../components/RouteLink.tsx";
import { RunHistoryBar } from "../components/RunHistoryBar.tsx";
import {
  Skeleton,
  SkeletonPanel,
  SkeletonRunHistory,
  SkeletonTable,
} from "../components/Skeleton.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import {
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatRelativeTime,
} from "../lib/format.ts";
import { type ItemLink, partitionModelData } from "./artifact_links.ts";
import {
  filterOutputs,
  type ModelOutput,
  outputPips,
  outputRunRoute,
} from "./model_executions.ts";
import "../styles/model-diagram.css";
import "../styles/models.css";

interface ModelDetailProps {
  modelName: string;
  onBack: () => void;
}

const STALE_TEXT: Record<string, string> = {
  upgradable: "Upgrade available",
  stranded: "Type missing",
  invalid: "Invalid",
  unknown: "Version unknown",
};

const EXECUTION_COLUMNS = [
  { header: "Method", cell: "mono" as const },
  { header: "Status", cell: "pill" as const },
  { header: "Duration", cell: 48 },
  { header: "Started", cell: 72 },
  { header: "Triggered by", cell: "40%" },
];

export function ModelDetail({ modelName, onBack }: ModelDetailProps) {
  const { data, error, errorInfo, refetch } = useRequest(
    "model.get",
    { modelIdOrName: modelName },
  );
  const model = extractObject<ModelInfo>(data);
  const { data: searchData, error: dataError } = useRequest(
    "data.search",
    { model: modelName, limit: 1000 },
  );
  const rows = useMemo(
    () => extractArray<ModelDataRow>(searchData),
    [searchData],
  );
  const { data: items, reports } = useMemo(
    () => partitionModelData(modelName, rows),
    [modelName, rows],
  );
  // The diagram's outputs and reports fall back to the model's data, so
  // it waits for that too rather than flashing "No outputs yet".
  const dataSettled = searchData !== null || dataError !== null;
  const spec = useMemo(
    () => (model && dataSettled ? buildDiagramSpec(model, rows) : null),
    [model, rows, dataSettled],
  );

  const stale = model?.staleness && model.staleness !== "current"
    ? STALE_TEXT[model.staleness] ?? model.staleness
    : null;

  return (
    <>
      <div className="page-header model-header">
        <div className="model-title">
          <button type="button" className="back-button" onClick={onBack}>
            &larr; Back
          </button>
          <div className="model-title-text">
            <h1>{modelName}</h1>
            <div className="model-subtitle">
              {model
                ? (
                  <>
                    <span className="mono">{model.type}</span>
                    {model.version !== undefined && (
                      <span className="model-badge">v{model.version}</span>
                    )}
                    {stale && (
                      <span
                        className="model-badge tone-warning"
                        title={model.typeVersion && model.currentTypeVersion
                          ? `Written for ${model.typeVersion}; current type is ${model.currentTypeVersion}`
                          : undefined}
                      >
                        {stale}
                      </span>
                    )}
                  </>
                )
                : !error && <Skeleton width={160} height={12} />}
            </div>
          </div>
        </div>
      </div>

      {error
        ? (
          <div className="panel">
            <EmptyState
              title={errorInfo?.code === "not_found"
                ? `Model "${modelName}" was not found`
                : "Couldn't load this model"}
              action={
                <span className="model-error-actions">
                  <button type="button" className="btn-sm" onClick={refetch}>
                    Retry
                  </button>
                  <button type="button" className="btn-sm" onClick={onBack}>
                    Back to models
                  </button>
                </span>
              }
            >
              {error}
            </EmptyState>
          </div>
        )
        : !model || !spec
        ? <ModelDetailSkeleton />
        : (
          <>
            <section className="panel model-diagram-panel">
              <div className="panel-header">
                <h2 className="panel-title">Inputs and outputs</h2>
              </div>
              <ModelDiagram spec={spec} onNavigate={navigateTo} />
            </section>

            <ModelExecutions modelName={modelName} modelId={model.id} />

            {(reports.length > 0 || items.length > 0) && (
              <div className="panels-grid model-section">
                <LinkPanel title="Reports" links={reports} />
                <LinkPanel title="Data" links={items} />
              </div>
            )}

            <section className="panel model-section">
              <div className="panel-header">
                <h2 className="panel-title">Definition</h2>
                <span className="panel-count">{model.type}</span>
              </div>
              <CodeBlock
                code={model.definition ??
                  yaml.dump(model, { lineWidth: -1, noRefs: true })}
                language="yaml"
              />
            </section>
          </>
        )}
    </>
  );
}

function ModelDetailSkeleton() {
  return (
    <>
      <section className="panel model-diagram-panel">
        <div className="panel-header">
          <h2 className="panel-title">Inputs and outputs</h2>
        </div>
        <ModelDiagramSkeleton />
      </section>
      <section className="panel model-section">
        <div className="panel-header">
          <h2 className="panel-title">Recent executions</h2>
        </div>
        <div className="model-exec-summary">
          <SkeletonRunHistory slots={40} height={18} />
        </div>
        <SkeletonTable
          columns={EXECUTION_COLUMNS}
          rows={5}
          label="Loading executions"
        />
      </section>
      <div className="panels-grid model-section">
        <SkeletonPanel title="Reports" rows={2} label="Loading reports" />
        <SkeletonPanel title="Data" rows={3} label="Loading data" />
      </div>
    </>
  );
}

function TriggeredBy({ output }: { output: ModelOutput }) {
  const to = outputRunRoute(output);
  if (to && output.workflowName) {
    return (
      <RouteLink to={to} title={`Open run ${output.workflowRunId}`}>
        {output.workflowName}
        {output.stepName && (
          <span className="model-exec-step">› {output.stepName}</span>
        )}
      </RouteLink>
    );
  }
  if (output.triggeredBy === "workflow") {
    return <span className="model-muted">workflow</span>;
  }
  return <span className="model-muted">{output.triggeredBy ?? "manual"}</span>;
}

const RECENT_ROWS = 10;
/** Executions asked for; a full page means there may be more in range. */
const EXECUTION_LIMIT = 200;
const PIP_SLOTS = 40;

/** The model's recent method runs within the dashboard time range. */
export function ModelExecutions(
  { modelName, modelId }: { modelName: string; modelId?: string },
) {
  const bounds = useTimeBounds();
  const { range } = useTimeRange();
  const { data, loading, error, refetch } = useRequest(
    "model.output.search",
    { model: modelName, ...bounds, limit: EXECUTION_LIMIT },
  );
  const outputs = useMemo(
    () =>
      filterOutputs(extractArray<ModelOutput>(data), {
        modelName,
        modelId,
        ...bounds,
      }),
    [data, modelName, modelId, bounds],
  );
  // Nothing in range: ask once more without the window, for "Last used".
  const needLastUsed = data !== null && !loading && outputs.length === 0;
  const { data: lastData } = useRequest(
    "model.output.search",
    { model: modelName, limit: 1 },
    { enabled: needLastUsed },
  );
  const lastUsed = outputs[0]?.startedAt ??
    filterOutputs(extractArray<ModelOutput>(lastData), {
      modelName,
      modelId,
    })[0]
      ?.startedAt ??
    null;

  const failed = outputs.filter((o) => o.status === "failed").length;
  // Older servers ignore the limit and send everything, so only a server
  // that honoured it can have cut the list short.
  const capped = outputs.length === EXECUTION_LIMIT;
  const total = `${formatCount(outputs.length)}${capped ? "+" : ""}`;
  const rangeText = describeTimeRange(range);
  const emptyTitle = range.kind === "preset" && range.preset === "all"
    ? "No executions yet"
    : range.kind === "preset"
    ? `No executions in the ${rangeText.toLowerCase()}`
    : `No executions between ${rangeText}`;

  return (
    <section className="panel model-section" aria-labelledby="model-exec-title">
      <div className="panel-header">
        <h2 className="panel-title" id="model-exec-title">
          Recent executions
          {data !== null && <span className="panel-count">{total}</span>}
        </h2>
        {lastUsed && (
          <span
            className="model-last-used"
            title={formatAbsoluteTime(lastUsed)}
          >
            Last used{" "}
            <time dateTime={lastUsed}>{formatRelativeTime(lastUsed)}</time>
          </span>
        )}
      </div>
      {error
        ? (
          <EmptyState
            title="Couldn't load executions"
            action={
              <button type="button" className="btn-sm" onClick={refetch}>
                Retry
              </button>
            }
          >
            {error}
          </EmptyState>
        )
        : data === null
        ? (
          <>
            <div className="model-exec-summary">
              <SkeletonRunHistory slots={PIP_SLOTS} height={18} />
            </div>
            <SkeletonTable
              columns={EXECUTION_COLUMNS}
              rows={5}
              label="Loading executions"
            />
          </>
        )
        : outputs.length === 0
        ? (
          <EmptyState title={emptyTitle}>
            {lastUsed
              ? `This model last ran ${
                formatRelativeTime(lastUsed)
              }. Widen the time range to see it.`
              : "Run one of its methods, directly or from a workflow, and it shows up here."}
          </EmptyState>
        )
        : (
          <>
            <div className="model-exec-summary">
              <RunHistoryBar
                runs={outputPips(outputs)}
                slots={PIP_SLOTS}
                height={18}
                noun="executions"
              />
              <span className="model-exec-counts">
                {total} {outputs.length === 1 ? "execution" : "executions"} ·
                {" "}
                {rangeText}
                {failed > 0 && (
                  <span className="model-exec-failed">
                    {` · ${formatCount(failed)} failed`}
                  </span>
                )}
              </span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {EXECUTION_COLUMNS.map((c) => (
                      <th key={c.header} scope="col">{c.header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {outputs.slice(0, RECENT_ROWS).map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{o.methodName}</td>
                      <td>
                        <StatusPill status={o.status} />
                      </td>
                      <td className="mono">{formatDuration(o.durationMs)}</td>
                      <td title={formatAbsoluteTime(o.startedAt)}>
                        <time dateTime={o.startedAt}>
                          {formatRelativeTime(o.startedAt)}
                        </time>
                      </td>
                      <td>
                        <TriggeredBy output={o} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </section>
  );
}

function LinkPanel({ title, links }: { title: string; links: ItemLink[] }) {
  if (links.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="panel-title">{title}</h2>
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
    </section>
  );
}
