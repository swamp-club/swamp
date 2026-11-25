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
import { useRequest } from "../client/useRequest.ts";
import { extractArray, extractObject } from "../client/extract.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { LoadError } from "../components/LoadError.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { loadState } from "../client/load_state.ts";
import { pluralize } from "../lib/format.ts";
import { VaultListSkeleton, VaultSectionSkeleton } from "./PageSkeletons.tsx";
import "../styles/vaults.css";

interface VaultDef {
  id: string;
  name: string;
  type: string;
}

interface VaultDetail {
  name: string;
  type: string;
  [key: string]: unknown;
}

interface VaultKey {
  key: string;
  labels?: Record<string, string>;
}

interface AuditEntry {
  timestamp: string;
  action: string;
  key?: string;
  principal?: string;
  [k: string]: unknown;
}

export function Vaults() {
  const req = useRequest("vault.search");
  const vaults = extractArray<VaultDef>(req.data);
  const state = loadState(req, () => vaults.length === 0);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <div className="page-header">
        <h1>Vaults</h1>
        <div className="header-right">
          {state === "loading"
            ? <Skeleton width={78} height={28} radius={20} />
            : (
              <div className="health-pill page-count-pill">
                {pluralize(vaults.length, "vault")}
              </div>
            )}
        </div>
      </div>

      {state === "loading" && <VaultListSkeleton />}
      {state === "error" && (
        <LoadError
          subject="vaults"
          message={req.error}
          onRetry={req.refetch}
        />
      )}
      {state === "empty" && (
        <div className="panel">
          <EmptyState title="No vaults configured">
            Vaults hold the secrets your behaviors reference. Create one with
            {" "}
            <code>swamp vault create local_encryption my-vault</code>.
          </EmptyState>
        </div>
      )}
      <div className="vaults-list">
        {state === "ready" &&
          vaults.map((v) => (
            <div key={v.id} className="panel">
              <button
                type="button"
                className="panel-header vault-toggle"
                aria-expanded={expanded === v.name}
                onClick={() => setExpanded(expanded === v.name ? null : v.name)}
              >
                <span className="panel-title">
                  <span
                    aria-hidden="true"
                    className={`vault-chevron${
                      expanded === v.name ? " is-expanded" : ""
                    }`}
                  >
                    &#9654;
                  </span>
                  {v.name}
                  <span className="cron-badge">{v.type}</span>
                </span>
              </button>
              {expanded === v.name && <VaultExpanded vaultName={v.name} />}
            </div>
          ))}
      </div>
    </>
  );
}

function VaultExpanded({ vaultName }: { vaultName: string }) {
  const descReq = useRequest("vault.describe", {
    vaultNameOrId: vaultName,
  });
  const keysReq = useRequest("vault.list-keys", {
    vaultName,
  });
  const auditReq = useRequest("vault.audit-trail", {
    vaultName,
    limit: 10,
  });

  const vaultInfo = extractObject<VaultDetail>(descReq.data);
  const keys = extractArray<VaultKey>(keysReq.data);
  const auditEntries = extractArray<AuditEntry>(auditReq.data);
  const descState = loadState(descReq, () => false);
  const keysState = loadState(keysReq, () => keys.length === 0);
  const auditState = loadState(auditReq, () => auditEntries.length === 0);

  return (
    <div className="vault-expanded">
      {/* Config */}
      <SectionHeader title="Configuration" />
      {descState === "loading" && (
        <VaultSectionSkeleton label="Loading vault configuration" rows={2} />
      )}
      {descState === "error" && (
        <LoadError
          subject="the vault's configuration"
          message={descReq.error}
          onRetry={descReq.refetch}
          inset
        />
      )}
      {vaultInfo && (
        <>
          {Object.entries(vaultInfo)
            .filter(([k]) =>
              k !== "name" && k !== "type" && k !== "id" && k !== "version"
            )
            .map(([key, val]) => (
              <div className="sys-row vault-config-row" key={key}>
                <span className="sys-key vault-config-key">
                  {key}
                </span>
                <span className="sys-val vault-config-val">
                  {typeof val === "object" ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))}
        </>
      )}

      {/* Keys */}
      <SectionHeader
        title={keysState === "loading" || keysState === "error"
          ? "Keys"
          : `Keys (${keys.length})`}
        border
      />
      {keysState === "loading" && (
        <VaultSectionSkeleton label="Loading keys" rows={3} />
      )}
      {keysState === "error" && (
        <LoadError
          subject="keys"
          message={keysReq.error}
          onRetry={keysReq.refetch}
          inset
        />
      )}
      {keysState === "empty" && (
        <div className="vault-section-empty">
          No keys stored yet. Add one with{" "}
          <code>swamp vault put {vaultName} &lt;key&gt;</code>.
        </div>
      )}
      {keysState === "ready" && (
        <div className="vault-keys">
          {keys.map((k) => {
            const keyName = typeof k === "string" ? k : k.key;
            return (
              <div key={keyName} className="vault-key-row">
                <span className="mono vault-key-name">
                  {keyName}
                </span>
                {typeof k === "object" && k.labels && (
                  <div className="vault-key-labels">
                    {Object.entries(k.labels).map(([lk, lv]) => (
                      <span className="cron-badge" key={lk}>
                        {lk}: {lv}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Audit trail */}
      <SectionHeader
        title={auditState === "ready"
          ? `Recent Activity (${auditEntries.length})`
          : "Recent Activity"}
        border
      />
      {auditState === "loading" && (
        <VaultSectionSkeleton label="Loading recent activity" rows={3} badge />
      )}
      {auditState === "error" && (
        <LoadError
          subject="recent activity"
          message={auditReq.error}
          onRetry={auditReq.refetch}
          inset
        />
      )}
      {auditState === "empty" && (
        <div className="vault-section-empty">
          No recent reads or writes of this vault.
        </div>
      )}
      {auditState === "ready" && (
        <>
          {auditEntries.map((entry, i) => (
            <div
              key={i}
              className={`vault-audit-row${
                i < auditEntries.length - 1 ? "" : " is-last"
              }`}
            >
              <span className="cron-badge">{entry.action}</span>
              <span className="mono vault-audit-key">
                {entry.key ?? "—"}
              </span>
              <span className="vault-audit-time">
                {entry.timestamp ? formatRelativeTime(entry.timestamp) : ""}
              </span>
            </div>
          ))}
        </>
      )}
      <div className="vault-expanded-end" />
    </div>
  );
}

function SectionHeader(
  { title, border = false }: { title: string; border?: boolean },
) {
  return (
    <div
      className={`vault-section-header${border ? " has-border" : ""}`}
    >
      {title}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
