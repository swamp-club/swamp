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

import { useState } from "react";
import { useSwamp } from "../client/SwampProvider.tsx";
import { useRequest } from "../client/useRequest.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { LoadError } from "../components/LoadError.tsx";
import {
  type AppEntry,
  type AppListReply,
  capabilityLabels,
} from "../apps/app_types.ts";

const STATE_LABELS: Record<AppEntry["state"], string> = {
  enabled: "✓ Enabled",
  pending: "◷ Pending",
  changed: "◷ Changed since approval",
};

export function AppRow(
  { app, canManage, busy, onApprove, onRevoke }: {
    app: AppEntry;
    canManage: boolean;
    busy: boolean;
    onApprove(app: AppEntry): void;
    onRevoke(app: AppEntry): void;
  },
) {
  const needsApproval = app.state !== "enabled";
  return (
    <div className="app-row">
      <div className="app-row-top">
        <div>
          <strong>{app.title}</strong>
          <small>
            {app.name}
            {app.version ? ` · ${app.version}` : ""}
            {app.dev ? " · dev server" : ""}
            {` · app platform ${app.platform}`}
          </small>
        </div>
        <div className="app-row-actions">
          <span className={`app-state app-state-${app.state}`}>
            {STATE_LABELS[app.state]}
          </span>
          {canManage && !app.dev && needsApproval && (
            <button
              type="button"
              className="btn-sm app-enable"
              disabled={busy}
              onClick={() => onApprove(app)}
            >
              Enable
            </button>
          )}
          {canManage && !app.dev && !needsApproval && (
            <button
              type="button"
              className="btn-sm"
              disabled={busy}
              onClick={() => onRevoke(app)}
            >
              Disable
            </button>
          )}
        </div>
      </div>
      <div className="app-caps">
        {capabilityLabels(app).map((label) => <code key={label}>{label}</code>)}
      </div>
      {!app.built && <p className="app-note">This app has not been built.</p>}
      {app.platformProblem !== undefined && (
        <p className="app-warning" role="status">
          This app cannot open on this server. {app.platformProblem}
        </p>
      )}
      {needsApproval && (
        <p className="app-warning">
          This app can send anything it reads to external sites. Enable it only
          if you trust its author with this data.
        </p>
      )}
    </div>
  );
}

export function ManageApps({ onChanged }: { onChanged(): void }) {
  const { request } = useSwamp();
  const { data, loading, error, refetch } = useRequest<AppListReply>(
    "app.list",
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const act = (type: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setFailure(null);
    request(type, payload)
      .then(() => {
        refetch();
        onChanged();
      })
      .catch((reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setBusy(false));
  };

  if (error !== null) {
    return <LoadError subject="apps" message={error} onRetry={refetch} />;
  }
  if (data === null) {
    return loading ? <div className="app-frame-loading">Loading…</div> : null;
  }
  const { apps, problems } = data.data;
  return (
    <div className="manage-apps">
      <div className="page-header">
        <h1>Manage apps</h1>
        <p>Applies to everyone using this repository.</p>
      </div>
      {failure !== null && <p className="app-warning" role="alert">{failure}
      </p>}
      {apps.length === 0 && (
        <EmptyState title="No apps installed">
          Install an extension with an app, or run swamp app init.
        </EmptyState>
      )}
      {apps.map((app) => (
        <AppRow
          key={app.name}
          app={app}
          canManage={data.canManage}
          busy={busy}
          onApprove={(entry) =>
            act("app.approve", {
              name: entry.name,
              capabilityKey: entry.capabilityKey,
            })}
          onRevoke={(entry) => act("app.revoke", { name: entry.name })}
        />
      ))}
      {problems.map((problem) => (
        <p key={problem.path} className="app-note">{problem.message}</p>
      ))}
    </div>
  );
}
