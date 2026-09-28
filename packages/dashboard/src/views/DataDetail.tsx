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

import { type ReactNode, useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import { CodeBlock } from "../components/CodeBlock";
import { Markdown } from "../components/Markdown";
import { RouteLink } from "../components/RouteLink";
import { ShareBar } from "../components/ShareBar";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import type { DetailView, RouteState } from "../routes.ts";
import {
  contentBytes,
  contentKind,
  type DataItem,
  documentTitle,
  isRequestedReport,
  latestVersion,
  matchesRunRef,
  type PageError,
  pageError,
  pairJsonVersion,
  prettyJson,
  RENDER_LIMIT,
  reportJsonName,
  resolveRunReportRefs,
  type RunView,
  shortRunId,
  type VersionInfo,
} from "./data_target.ts";
import { reportDataName } from "./report_name.ts";

type ItemDetail = Extract<
  NonNullable<DetailView>,
  { kind: "data" | "report" | "runReport" }
>;

interface DataDetailProps {
  detail: ItemDetail;
  onBack: () => void;
}

/**
 * The shareable page for one data item, one version of it, or a report —
 * the target of `/models/<m>/data/<d>[/versions/<n>]`,
 * `/models/<m>/reports/<r>` and `/workflows/<wf>/runs/<id>/reports/<r>`.
 */
export function DataDetail({ detail, onBack }: DataDetailProps) {
  switch (detail.kind) {
    case "data":
      return <DataItemPage detail={detail} onBack={onBack} />;
    case "report":
      return <ModelReportPage detail={detail} onBack={onBack} />;
    case "runReport":
      return <RunReportPage detail={detail} onBack={onBack} />;
  }
}

// ── data item / version ────────────────────────────────────────────────

function DataItemPage(
  { detail, onBack }: {
    detail: Extract<ItemDetail, { kind: "data" }>;
    onBack: () => void;
  },
) {
  const { modelName, dataName, version } = detail;
  const itemReq = useRequest("data.get", {
    modelIdOrName: modelName,
    dataName,
    ...(version !== undefined && { version }),
    includeContent: true,
  });
  const versionsReq = useRequest("data.versions", {
    modelIdOrName: modelName,
    dataName,
  });
  const item = itemReq.error ? null : extractObject<DataItem>(itemReq.data);
  const versions = versionList(versionsReq.data);
  const json = useReportJson(modelName, item);
  const error = pageError(
    itemReq.error,
    itemReq.errorInfo,
    version !== undefined,
  );
  const latest = latestVersion(versions);
  const isReport = item?.tags.type === "report";

  return (
    <ItemPage
      title={isReport ? item.tags.reportName : dataName}
      kindLabel={isReport ? "report" : "data"}
      context={modelName}
      onBack={onBack}
      breadcrumb={<ModelCrumb modelName={modelName} />}
      link={{ view: "models", detail }}
      permalink={version === undefined && item
        ? {
          view: "models",
          detail: { kind: "data", modelName, dataName, version: item.version },
        }
        : undefined}
      loading={itemReq.loading}
      error={error}
      errorLinks={
        <>
          {version !== undefined && (
            <RouteLink
              to={{
                view: "models",
                detail: { kind: "data", modelName, dataName },
              }}
            >
              View the latest version
            </RouteLink>
          )}
          <RouteLink
            to={{ view: "models", detail: { kind: "model", modelName } }}
          >
            Open {modelName}
          </RouteLink>
        </>
      }
      onRetry={itemReq.refetch}
      item={item}
      json={json}
      stale={version !== undefined && latest !== null && latest > version
        ? {
          latest,
          to: {
            view: "models",
            detail: { kind: "data", modelName, dataName },
          },
        }
        : undefined}
      versions={versions.length > 0
        ? {
          list: versions,
          current: item?.version ?? version,
          linkFor: (v) => ({
            view: "models",
            detail: { kind: "data", modelName, dataName, version: v },
          }),
        }
        : undefined}
    />
  );
}

// ── model report (latest) ──────────────────────────────────────────────

function ModelReportPage(
  { detail, onBack }: {
    detail: Extract<ItemDetail, { kind: "report" }>;
    onBack: () => void;
  },
) {
  const { modelName, reportName, variant } = detail;
  const dataName = reportDataName(reportName, variant);
  const itemReq = useRequest("data.get", {
    modelIdOrName: modelName,
    dataName,
    includeContent: true,
  });
  const versionsReq = useRequest("data.versions", {
    modelIdOrName: modelName,
    dataName,
  });
  const fetched = itemReq.error ? null : extractObject<DataItem>(itemReq.data);
  // Sanitised report names can collide; only show the report that was asked for.
  const mismatch = fetched !== null &&
    !isRequestedReport(fetched, reportName, variant);
  const item = mismatch ? null : fetched;
  const json = useReportJson(modelName, item);
  const versions = versionList(versionsReq.data);
  const error: PageError | null = mismatch
    ? { kind: "not-found", entity: "Report" }
    : relabel(pageError(itemReq.error, itemReq.errorInfo, false), "Report");

  return (
    <ItemPage
      title={variant ? `${reportName} · ${variant}` : reportName}
      kindLabel="report"
      context={modelName}
      onBack={onBack}
      breadcrumb={<ModelCrumb modelName={modelName} />}
      link={{ view: "models", detail }}
      permalink={item
        ? {
          view: "models",
          detail: {
            kind: "data",
            modelName,
            dataName: item.name,
            version: item.version,
          },
        }
        : undefined}
      loading={itemReq.loading}
      error={error}
      errorLinks={
        <RouteLink
          to={{ view: "models", detail: { kind: "model", modelName } }}
        >
          Open {modelName}
        </RouteLink>
      }
      onRetry={itemReq.refetch}
      item={item}
      json={json}
      versions={versions.length > 0
        ? {
          list: versions,
          current: item?.version,
          linkFor: (v) => ({
            view: "models",
            detail: { kind: "data", modelName, dataName, version: v },
          }),
        }
        : undefined}
    />
  );
}

// ── a run's workflow-scope report ──────────────────────────────────────

function RunReportPage(
  { detail, onBack }: {
    detail: Extract<ItemDetail, { kind: "runReport" }>;
    onBack: () => void;
  },
) {
  const { workflowName, runId, reportName } = detail;
  const historyReq = useRequest("workflow.history.get", {
    workflowIdOrName: runId,
  });
  const run = historyReq.error ? null : extractObject<RunView>(historyReq.data);
  const refs = run ? resolveRunReportRefs(run, workflowName, reportName) : null;
  const md = refs?.status === "ok" ? refs.markdown : null;
  const jsonRef = refs?.status === "ok" ? refs.json : undefined;

  // Ask for the exact versions the run recorded, so a later run's report is
  // never shown under this run's link.
  const mdReq = useRequest("data.get", {
    workflowName,
    runId,
    dataName: md?.name,
    version: md?.version,
    includeContent: true,
  }, { enabled: md !== null });
  const jsonReq = useRequest("data.get", {
    workflowName,
    runId,
    dataName: jsonRef?.name,
    version: jsonRef?.version,
    includeContent: true,
  }, { enabled: jsonRef !== undefined });

  const fetched = mdReq.error ? null : extractObject<DataItem>(mdReq.data);
  const superseded = fetched !== null && md !== null &&
    !matchesRunRef(fetched, md);
  const item = superseded ? null : fetched;
  const jsonFetched = jsonReq.error
    ? null
    : extractObject<DataItem>(jsonReq.data);
  const json = jsonFetched && jsonRef && matchesRunRef(jsonFetched, jsonRef)
    ? jsonFetched
    : null;

  let error: PageError | null = pageError(
    historyReq.error,
    historyReq.errorInfo,
    true,
  );
  if (!error && refs?.status === "wrong-workflow") {
    error = { kind: "not-found", entity: "Workflow run" };
  } else if (!error && refs?.status === "missing") {
    error = { kind: "not-found", entity: "Report" };
  } else if (!error && superseded) {
    error = { kind: "superseded" };
  } else if (!error) {
    const mdError = pageError(mdReq.error, mdReq.errorInfo, true);
    error = mdError?.kind === "gone" ? { kind: "superseded" } : mdError;
  }

  const runRoute: RouteState = {
    view: "workflows",
    detail: { kind: "run", workflowName, runId },
  };

  return (
    <ItemPage
      title={reportName}
      kindLabel="report"
      context={`${workflowName} run ${shortRunId(runId)}`}
      onBack={onBack}
      breadcrumb={
        <>
          <RouteLink
            to={{
              view: "workflows",
              detail: { kind: "workflow", workflowName },
            }}
          >
            {workflowName}
          </RouteLink>
          <span aria-hidden="true">›</span>
          <RouteLink to={runRoute}>run {shortRunId(runId)}</RouteLink>
        </>
      }
      link={{ view: "workflows", detail }}
      // Between the run loading and the report request starting, treat the
      // report as loading so the page never renders blank for a frame.
      loading={historyReq.loading ||
        (md !== null && (mdReq.loading || (!mdReq.data && !mdReq.error)))}
      error={error}
      errorLinks={
        <>
          <RouteLink to={runRoute}>Open the run</RouteLink>
          <RouteLink
            to={{
              view: "workflows",
              detail: { kind: "workflow", workflowName },
            }}
          >
            Open {workflowName}
          </RouteLink>
        </>
      }
      onRetry={() => {
        historyReq.refetch();
        mdReq.refetch();
      }}
      item={item}
      json={json}
    />
  );
}

// ── shared pieces ──────────────────────────────────────────────────────

/** Loads the JSON half of a model report, paired to the markdown version. */
function useReportJson(
  modelName: string,
  item: DataItem | null,
): DataItem | null {
  const jsonName = item ? reportJsonName(item) : null;
  const versionsReq = useRequest("data.versions", {
    modelIdOrName: modelName,
    dataName: jsonName,
  }, { enabled: jsonName !== null });
  const paired = item && jsonName
    ? pairJsonVersion(item.createdAt, versionList(versionsReq.data))
    : null;
  const jsonReq = useRequest("data.get", {
    modelIdOrName: modelName,
    dataName: jsonName,
    version: paired,
    includeContent: true,
  }, { enabled: paired !== null });
  return jsonReq.error ? null : extractObject<DataItem>(jsonReq.data);
}

function versionList(payload: unknown): VersionInfo[] {
  const data = extractObject<{ versions?: VersionInfo[] }>(payload);
  return Array.isArray(data?.versions) ? data.versions : [];
}

function relabel(error: PageError | null, entity: string): PageError | null {
  return error?.kind === "not-found" && error.entity === "Data"
    ? { kind: "not-found", entity }
    : error;
}

function ModelCrumb({ modelName }: { modelName: string }) {
  return (
    <>
      <RouteLink to={{ view: "models", detail: null }}>Models</RouteLink>
      <span aria-hidden="true">›</span>
      <RouteLink to={{ view: "models", detail: { kind: "model", modelName } }}>
        {modelName}
      </RouteLink>
    </>
  );
}

interface ItemPageProps {
  title: string;
  kindLabel: string;
  context: string;
  onBack: () => void;
  breadcrumb: ReactNode;
  link: RouteState;
  permalink?: RouteState;
  loading: boolean;
  error: PageError | null;
  errorLinks: ReactNode;
  onRetry: () => void;
  item: DataItem | null;
  json: DataItem | null;
  stale?: { latest: number; to: RouteState };
  versions?: {
    list: VersionInfo[];
    current?: number;
    linkFor: (version: number) => RouteState;
  };
}

function ItemPage(props: ItemPageProps) {
  const { title, kindLabel, item, error, loading } = props;
  useDocumentTitle(documentTitle(title, props.context));

  return (
    <>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" className="back-button" onClick={props.onBack}>
            &larr; Back
          </button>
          <h1 className="item-title">{title}</h1>
          <span className="cron-badge">{kindLabel}</span>
          {item && <span className="cron-badge">v{item.version}</span>}
        </div>
        <div className="header-right">
          <ShareBar link={props.link} permalink={props.permalink} />
        </div>
      </div>

      <nav className="breadcrumb" aria-label="Breadcrumb">
        {props.breadcrumb}
      </nav>

      {props.stale && item && (
        <div className="notice notice-warning">
          Viewing v{item.version} · latest is v{props.stale.latest}{" "}
          <RouteLink to={props.stale.to}>View latest &rarr;</RouteLink>
        </div>
      )}

      {loading && !item && !error && (
        <div className="loading">Loading&hellip;</div>
      )}

      {error && (
        <ErrorNotice
          error={error}
          links={props.errorLinks}
          onRetry={props.onRetry}
        />
      )}

      {item && !error && (
        <>
          <ContentPanel item={item} json={props.json} />
          <div className="panels-grid">
            <MetadataPanel item={item} />
            {props.versions && (
              <VersionsPanel
                versions={props.versions.list}
                current={props.versions.current}
                linkFor={props.versions.linkFor}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

function ErrorNotice(
  { error, links, onRetry }: {
    error: PageError;
    links: ReactNode;
    onRetry: () => void;
  },
) {
  let message: ReactNode;
  switch (error.kind) {
    case "denied":
      message = "You don't have access to this data.";
      break;
    case "gone":
      message =
        "This version is no longer available. Only a data item's most recent versions are kept, and reports expire after 30 days.";
      break;
    case "superseded":
      message =
        "This run's report is no longer available — a later run has replaced it, or it has expired.";
      break;
    case "not-found":
      message = `${error.entity} not found.`;
      break;
    case "pending":
      message = "The run is still in progress, so this isn't available yet.";
      break;
    case "failed":
      message = error.message;
      break;
  }
  return (
    <div
      className={`notice ${
        error.kind === "failed" || error.kind === "denied"
          ? "notice-danger"
          : "notice-warning"
      }`}
      role="alert"
    >
      <div>{message}</div>
      <div className="notice-links">
        {links}
        {(error.kind === "pending" || error.kind === "failed") && (
          <button type="button" className="btn-sm" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

type ContentTab = "rendered" | "source" | "json";

function ContentPanel(
  { item, json }: { item: DataItem; json: DataItem | null },
) {
  const [tab, setTab] = useState<ContentTab>("rendered");
  const [showAll, setShowAll] = useState(false);
  const kind = contentKind(item.contentType, item.contentEncoding);
  const content = item.content;

  const tabs: Array<[ContentTab, string]> = kind === "markdown"
    ? [["rendered", "Rendered"], ["source", "Source"]]
    : [];
  if (json?.content !== undefined) tabs.push(["json", "JSON"]);

  const shown = tab === "json" && json?.content !== undefined
    ? json.content
    : content;
  const truncated = shown !== undefined && !showAll &&
    shown.length > RENDER_LIMIT;
  const text = truncated ? shown.slice(0, RENDER_LIMIT) : shown;

  const download = () => {
    if (content === undefined) return;
    const blob = new Blob([
      new Uint8Array(contentBytes(content, item.contentEncoding)),
    ], {
      type: item.contentType || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.name}${extensionFor(kind)}`;
    a.click();
    // Revoking in the same tick can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <div className="panel-title">
          Content
          {tabs.length > 1 && (
            <div className="tab-group" role="tablist">
              {tabs.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`btn-sm${tab === id ? " active" : ""}`}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {content !== undefined && (
          <button type="button" className="btn-sm" onClick={download}>
            Download
          </button>
        )}
      </div>
      <div className="content-body">
        {text === undefined
          ? <div className="loading">No content stored for this version.</div>
          : kind === "binary" && tab !== "json"
          ? (
            <div className="loading">
              Binary content · {formatBytes(item.size ?? content?.length ?? 0)}
            </div>
          )
          : tab === "json"
          ? <CodeBlock code={prettyJson(text)} language="json" />
          : kind === "markdown" && tab === "rendered"
          ? <Markdown source={text} />
          : kind === "json"
          ? <CodeBlock code={prettyJson(text)} language="json" />
          : kind === "yaml"
          ? <CodeBlock code={text} language="yaml" />
          : <pre className="code-block">{text}</pre>}
        {truncated && (
          <div className="notice notice-info">
            Showing the first {formatBytes(RENDER_LIMIT)}.{" "}
            <button
              type="button"
              className="btn-sm"
              onClick={() => setShowAll(true)}
            >
              Show all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MetadataPanel({ item }: { item: DataItem }) {
  const rows: Array<[string, ReactNode]> = [
    ["Version", `v${item.version}`],
    ["Created", new Date(item.createdAt).toLocaleString()],
    ["Content type", item.contentType],
  ];
  if (item.size !== undefined) rows.push(["Size", formatBytes(item.size)]);
  if (item.lifetime) rows.push(["Lifetime", item.lifetime]);
  if (item.garbageCollection !== undefined) {
    rows.push(["Versions kept", String(item.garbageCollection)]);
  }
  if (item.checksum) {
    rows.push([
      "Checksum",
      <span key="checksum" className="mono" title={item.checksum}>
        {item.checksum.slice(0, 12)}
      </span>,
    ]);
  }
  const tags = Object.entries(item.tags);
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">Details</div>
      </div>
      <div className="detail-rows">
        {rows.map(([key, value]) => (
          <div className="detail-row" key={key}>
            <span className="detail-key">{key}</span>
            <span className="detail-val">{value}</span>
          </div>
        ))}
        {tags.length > 0 && (
          <div className="detail-row">
            <span className="detail-key">Tags</span>
            <span className="detail-val tag-list">
              {tags.map(([k, v]) => (
                <span className="cron-badge" key={k}>{k}={v}</span>
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function VersionsPanel(
  { versions, current, linkFor }: {
    versions: VersionInfo[];
    current?: number;
    linkFor: (version: number) => RouteState;
  },
) {
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">Versions</div>
        <span className="panel-count">{versions.length}</span>
      </div>
      <ul className="version-list">
        {versions.map((v) => (
          <li
            key={v.version}
            className={v.version === current ? "current" : undefined}
          >
            <RouteLink to={linkFor(v.version)}>v{v.version}</RouteLink>
            {v.isLatest && <span className="cron-badge">latest</span>}
            {v.version === current && (
              <span className="cron-badge">viewing</span>
            )}
            <span className="mono version-time">
              {new Date(v.createdAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function extensionFor(kind: ReturnType<typeof contentKind>): string {
  switch (kind) {
    case "markdown":
      return ".md";
    case "json":
      return ".json";
    case "yaml":
      return ".yaml";
    case "text":
      return ".txt";
    case "binary":
      return "";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
