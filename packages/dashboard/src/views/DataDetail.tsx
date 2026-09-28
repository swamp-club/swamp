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

import { type ReactNode, useEffect, useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import {
  type ContentKind,
  contentPlanFor,
  formatBytes,
  prettyJson,
} from "../client/content_kind.ts";
import {
  findArtifactWithTwin,
  resolveRunReport,
  type RunArtifacts,
  runReportNames,
} from "../client/run_report.ts";
import { CodeBlock } from "../components/CodeBlock";
import { DetailLink } from "../components/DetailLink";
import { Markdown } from "../components/Markdown";
import type { DetailView } from "../routes.ts";

type DataDetailTarget = Extract<
  NonNullable<DetailView>,
  { kind: "data" | "runData" | "runReport" }
>;

/** Where a data item is read from: a model, or the run that produced it. */
type DataSource =
  | { kind: "model"; modelName: string; dataName: string; version?: number }
  | {
    kind: "run";
    workflowName: string;
    runId: string;
    dataName: string;
    version?: number;
    /** Tells apart same-named items of different models in one run. */
    dataId?: string;
  };

interface DataMeta {
  id?: string;
  name: string;
  modelName: string;
  modelType: string;
  version: number;
  contentType: string;
  lifetime?: string;
  tags?: Record<string, string>;
  createdAt?: string;
  size?: number;
  ownerDefinition?: { workflowName?: string; workflowRunId?: string };
  content?: string;
  contentEncoding?: "utf-8" | "base64";
}

interface VersionInfo {
  version: number;
  createdAt: string;
  size?: number;
  isLatest: boolean;
}

interface DataDetailProps {
  target: DataDetailTarget;
  onBack: () => void;
}

export function DataDetail({ target, onBack }: DataDetailProps) {
  if (target.kind === "runReport") {
    return <RunReportDetail target={target} onBack={onBack} />;
  }
  const source: DataSource = target.kind === "data"
    ? {
      kind: "model",
      modelName: target.modelName,
      dataName: target.dataName,
      version: target.version,
    }
    : {
      kind: "run",
      workflowName: target.workflowName,
      runId: target.runId,
      dataName: target.dataName,
      version: target.version,
      dataId: target.dataId,
    };
  return (
    <DataItemDetail
      source={source}
      title={target.dataName}
      onBack={onBack}
    />
  );
}

/** data.get payload for a source. The run form sends `dataName`, not
 * `modelIdOrName`, so serve authorizes it as a read on data:"*". */
function dataGetPayload(
  source: DataSource,
  dataName: string,
  version: number | undefined,
  includeContent: boolean,
  dataId: string | undefined = source.kind === "run"
    ? source.dataId
    : undefined,
): Record<string, unknown> {
  const base = source.kind === "model"
    ? { modelIdOrName: source.modelName, dataName }
    : { workflowName: source.workflowName, runId: source.runId, dataName };
  return {
    ...base,
    ...(version !== undefined ? { version } : {}),
    ...(source.kind === "run" && dataId !== undefined ? { dataId } : {}),
    includeContent,
  };
}

/** The shareable link that pins `source` to one version. */
function pinnedLink(
  source: DataSource,
  version: number,
): NonNullable<DetailView> {
  return source.kind === "model"
    ? {
      kind: "data",
      modelName: source.modelName,
      dataName: source.dataName,
      version,
    }
    : {
      kind: "runData",
      workflowName: source.workflowName,
      runId: source.runId,
      dataName: source.dataName,
      version,
      ...(source.dataId !== undefined ? { dataId: source.dataId } : {}),
    };
}

function parentLink(source: DataSource): NonNullable<DetailView> {
  return source.kind === "model"
    ? { kind: "model", modelName: source.modelName }
    : { kind: "run", workflowName: source.workflowName, runId: source.runId };
}

/** A missing data item (expired or GC'd), not a mistyped model or run. */
function isDataNotFound(error: string): boolean {
  return /\bdata\b.*\bnot found\b/i.test(error);
}

function isUnauthorized(error: string): boolean {
  return /unauthori[sz]ed|access denied/i.test(error);
}

/**
 * Fetches `type` only while `payload` is non-null, so content is requested
 * after the metadata says it is worth fetching.
 */
function useConditionalRequest<T>(
  type: string,
  payload: Record<string, unknown> | null,
): { data: T | null; loading: boolean; error: string | null } {
  const { connected, request } = useSwamp();
  const [state, setState] = useState<
    { data: T | null; loading: boolean; error: string | null }
  >({ data: null, loading: false, error: null });
  // The payload is compared by its JSON form, as useRequest does.
  const key = payload ? JSON.stringify(payload) : "";

  useEffect(() => {
    if (!connected || !payload) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    request<T>(type, payload).then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      },
      (err: Error) => {
        if (!cancelled) {
          setState({ data: null, loading: false, error: err.message });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connected, type, key, request]);

  return state;
}

function DataItemDetail(
  { source, title, onBack }: {
    source: DataSource;
    title: string;
    onBack: () => void;
  },
) {
  const metaReq = useRequest(
    "data.get",
    dataGetPayload(source, source.dataName, source.version, false),
  );
  const meta = metaReq.error ? null : extractObject<DataMeta>(metaReq.data);

  const plan = meta ? contentPlanFor(meta.contentType, meta.size) : null;
  const [loadRequested, setLoadRequested] = useState(false);
  const shouldFetch = plan !== null &&
    (plan.fetch === "auto" || (plan.fetch === "onDemand" && loadRequested));
  const contentReq = useConditionalRequest<unknown>(
    "data.get",
    meta && shouldFetch
      ? dataGetPayload(source, source.dataName, meta.version, true)
      : null,
  );
  const withContent = extractObject<DataMeta>(contentReq.data);

  // A report's Markdown has a structured -json twin written alongside it.
  // On a model it shares the Markdown's version. In a run, the twin is
  // located from the run's own refs (same step), so it is pinned by id.
  const isReport = meta?.tags?.type === "report" &&
    contentPlanFor(meta.contentType, 0).kind === "markdown";
  const runReq = useConditionalRequest<unknown>(
    "workflow.history.get",
    meta && isReport && source.kind === "run"
      ? { workflowIdOrName: source.runId }
      : null,
  );
  const runTwin = meta && source.kind === "run" && runReq.data
    ? findArtifactWithTwin(
      extractObject<RunArtifacts>(runReq.data) ?? {},
      source.dataId ?? meta.id ?? "",
      meta.version,
    )?.twin
    : undefined;
  const twinReq = useConditionalRequest<unknown>(
    "data.get",
    !meta || !isReport
      ? null
      : source.kind === "model"
      ? dataGetPayload(source, `${meta.name}-json`, meta.version, true)
      : runTwin
      ? dataGetPayload(
        source,
        runTwin.ref.name,
        runTwin.ref.version,
        true,
        runTwin.ref.dataId,
      )
      : null,
  );
  const twin = extractObject<DataMeta>(twinReq.data);

  const versionsReq = useConditionalRequest<unknown>(
    "data.versions",
    source.kind === "model"
      ? { modelIdOrName: source.modelName, dataName: source.dataName }
      : null,
  );
  const versions =
    extractObject<{ versions?: VersionInfo[] }>(versionsReq.data)?.versions ??
      [];

  const runWorkflow = meta?.ownerDefinition?.workflowName;
  const runId = meta?.ownerDefinition?.workflowRunId;

  return (
    <>
      <DetailHeader title={title} onBack={onBack}>
        {meta && (
          <span
            className="mono"
            style={{ fontSize: "0.78rem", color: "var(--text-3)" }}
          >
            {meta.contentType} · v{meta.version}
          </span>
        )}
      </DetailHeader>

      {metaReq.loading && <div className="loading">Loading data...</div>}
      {metaReq.error && <LoadError error={metaReq.error} source={source} />}

      {meta && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <div className="panel-title">Details</div>
            <DetailLink
              to={pinnedLink(source, meta.version)}
              className="mono"
              style={{ fontSize: "0.78rem" }}
              title="Link to this exact version"
            >
              Link to v{meta.version}
            </DetailLink>
          </div>
          <dl className="meta-grid">
            <dt>Owner</dt>
            <dd className="mono">
              {meta.modelType === "workflow"
                // A workflow owner is reported by id; the route has its name.
                ? `workflow ${
                  source.kind === "run" ? source.workflowName : meta.modelName
                }`
                : (
                  <DetailLink to={{ kind: "model", modelName: meta.modelName }}>
                    {meta.modelName}
                  </DetailLink>
                )}
            </dd>
            {runWorkflow && runId && (
              <>
                <dt>Produced by</dt>
                <dd className="mono">
                  <DetailLink
                    to={{ kind: "run", workflowName: runWorkflow, runId }}
                  >
                    {runWorkflow} run {runId}
                  </DetailLink>
                </dd>
              </>
            )}
            {meta.createdAt && (
              <>
                <dt>Created</dt>
                <dd>{new Date(meta.createdAt).toLocaleString()}</dd>
              </>
            )}
            {meta.size !== undefined && (
              <>
                <dt>Size</dt>
                <dd>{formatBytes(meta.size)}</dd>
              </>
            )}
            {meta.lifetime && (
              <>
                <dt>Lifetime</dt>
                <dd>{meta.lifetime}</dd>
              </>
            )}
            {meta.tags && Object.keys(meta.tags).length > 0 && (
              <>
                <dt>Tags</dt>
                <dd style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {Object.entries(meta.tags).map(([k, v]) => (
                    <span className="cron-badge" key={k}>{k}={v}</span>
                  ))}
                </dd>
              </>
            )}
            {versions.length > 1 && source.kind === "model" && (
              <>
                <dt>Versions</dt>
                <dd style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {versions.map((v) =>
                    v.version === meta.version
                      ? (
                        <span className="cron-badge" key={v.version}>
                          v{v.version}
                        </span>
                      )
                      : (
                        <DetailLink
                          key={v.version}
                          className="cron-badge"
                          to={{
                            kind: "data",
                            modelName: source.modelName,
                            dataName: source.dataName,
                            version: v.version,
                          }}
                        >
                          v{v.version}
                        </DetailLink>
                      )
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      {meta && plan && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <div className="panel-title">Content</div>
            <span className="panel-count">{plan.kind}</span>
          </div>
          {plan.fetch === "never" && (
            <div className="loading">
              {plan.kind === "binary"
                ? "Binary content is not shown."
                : "Too large to show inline."}
              {meta.size !== undefined && ` ${formatBytes(meta.size)}.`}
            </div>
          )}
          {plan.fetch === "onDemand" && !loadRequested && (
            <div className="loading">
              <button
                type="button"
                className="btn-sm"
                onClick={() => setLoadRequested(true)}
              >
                Load content (size unknown)
              </button>
            </div>
          )}
          {contentReq.loading && (
            <div className="loading">Loading content...</div>
          )}
          {contentReq.error && (
            <div className="loading" style={{ color: "var(--danger)" }}>
              {contentReq.error}
            </div>
          )}
          {withContent && <ContentBody kind={plan.kind} item={withContent} />}
        </div>
      )}

      {twin?.content !== undefined && (
        <div className="panel">
          <details>
            <summary
              className="panel-header"
              style={{ cursor: "pointer" }}
            >
              <span className="panel-title">Report data (JSON)</span>
            </summary>
            <CodeBlock code={prettyJson(twin.content)} language="json" />
          </details>
        </div>
      )}
    </>
  );
}

function ContentBody({ kind, item }: { kind: ContentKind; item: DataMeta }) {
  if (item.content === undefined) {
    return <div className="loading">No content stored.</div>;
  }
  if (item.contentEncoding === "base64") {
    return <div className="loading">Binary content is not shown.</div>;
  }
  switch (kind) {
    case "markdown":
      return <Markdown source={item.content} />;
    case "json":
      return <CodeBlock code={prettyJson(item.content)} language="json" />;
    case "yaml":
      return <CodeBlock code={item.content} language="yaml" />;
    default:
      return <pre className="code-block">{item.content}</pre>;
  }
}

function LoadError({ error, source }: { error: string; source: DataSource }) {
  const parent = parentLink(source);
  const parentLabel = source.kind === "model"
    ? `model ${source.modelName}`
    : `run ${source.runId}`;
  if (isDataNotFound(error)) {
    return (
      <Notice>
        This data is no longer available. It may have expired or been
        garbage-collected. Open the{" "}
        <DetailLink to={parent}>{parentLabel}</DetailLink>.
      </Notice>
    );
  }
  return (
    <Notice danger>
      {error}
      {source.kind === "run" && isUnauthorized(error) && (
        <div style={{ color: "var(--text-2)", marginTop: 8 }}>
          Run links need read access to all data. If you can read the owning
          model's data, open it from that model instead.
        </div>
      )}
    </Notice>
  );
}

function RunReportDetail(
  { target, onBack }: {
    target: Extract<DataDetailTarget, { kind: "runReport" }>;
    onBack: () => void;
  },
) {
  const { data, loading, error } = useRequest("workflow.history.get", {
    workflowIdOrName: target.runId,
  });
  const run = error ? null : extractObject<RunArtifacts>(data);
  const runLink: NonNullable<DetailView> = {
    kind: "run",
    workflowName: target.workflowName,
    runId: target.runId,
  };

  if (loading) {
    return (
      <>
        <DetailHeader title={target.reportName} onBack={onBack} />
        <div className="loading">Loading run...</div>
      </>
    );
  }
  if (error || !run) {
    return (
      <>
        <DetailHeader title={target.reportName} onBack={onBack} />
        <Notice danger>{error ?? "Run not found"}</Notice>
      </>
    );
  }

  const resolution = resolveRunReport(run, target.reportName);
  if (resolution.kind === "found") {
    const { ref } = resolution.artifact;
    return (
      <DataItemDetail
        source={{
          kind: "run",
          workflowName: target.workflowName,
          runId: target.runId,
          dataName: ref.name,
          version: ref.version,
          dataId: ref.dataId,
        }}
        title={target.reportName}
        onBack={onBack}
      />
    );
  }

  return (
    <>
      <DetailHeader title={target.reportName} onBack={onBack} />
      <Notice>
        {resolution.kind === "notFound"
          ? (
            <NotRecorded
              reportName={target.reportName}
              recorded={runReportNames(run)}
              workflowName={target.workflowName}
              runId={target.runId}
              runLink={runLink}
            />
          )
          : (
            <>
              This run produced {target.reportName} more than once. Choose one:
              <ul style={{ marginTop: 8 }}>
                {resolution.candidates.map((c) => (
                  <li key={`${c.ref.dataId}-${c.ref.version}`}>
                    <DetailLink
                      to={{
                        kind: "runData",
                        workflowName: target.workflowName,
                        runId: target.runId,
                        dataName: c.ref.name,
                        version: c.ref.version,
                        dataId: c.ref.dataId,
                      }}
                    >
                      {c.ref.name} v{c.ref.version}
                    </DetailLink>
                    {c.stepName &&
                      ` (step ${c.stepName}${
                        c.modelName ? `, model ${c.modelName}` : ""
                      })`}
                  </li>
                ))}
              </ul>
            </>
          )}
      </Notice>
    </>
  );
}

/**
 * The run has no report by this name. A link cut short by line wrapping or a
 * chat client usually lands here with a partial name, so list the reports the
 * run did record.
 */
function NotRecorded(
  { reportName, recorded, workflowName, runId, runLink }: {
    reportName: string;
    recorded: string[];
    workflowName: string;
    runId: string;
    runLink: NonNullable<DetailView>;
  },
) {
  return (
    <>
      This run did not record a {reportName} report. {recorded.length > 0
        ? (
          <>
            It recorded:
            <ul style={{ margin: "8px 0", padding: 0, listStyle: "none" }}>
              {recorded.map((name) => (
                <li key={name}>
                  <DetailLink
                    to={{
                      kind: "runReport",
                      workflowName,
                      runId,
                      reportName: name,
                    }}
                  >
                    {name}
                  </DetailLink>
                </li>
              ))}
            </ul>
            Or open the <DetailLink to={runLink}>run</DetailLink>.
          </>
        )
        : (
          <>
            Open the <DetailLink to={runLink}>run</DetailLink>.
          </>
        )}
    </>
  );
}

/**
 * A message panel. `.loading` is a flex container, so the content sits in one
 * inner element to keep inline text and links flowing (with their spaces).
 */
function Notice(
  { children, danger }: { children: ReactNode; danger?: boolean },
) {
  return (
    <div
      className="panel loading"
      style={danger ? { color: "var(--danger)" } : undefined}
    >
      <div style={{ maxWidth: 640, textAlign: "center" }}>{children}</div>
    </div>
  );
}

function DetailHeader(
  { title, onBack, children }: {
    title: string;
    onBack: () => void;
    children?: ReactNode;
  },
) {
  return (
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
        <h1>{title}</h1>
      </div>
      {children && <div className="header-right">{children}</div>}
    </div>
  );
}
