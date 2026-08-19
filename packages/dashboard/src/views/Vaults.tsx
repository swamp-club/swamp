import { useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import { useRequest } from "../client/useRequest";
import { extractArray, extractObject } from "../client/extract";

interface VaultDef {
  id: string;
  name: string;
  type: string;
}

interface VaultDetail {
  name: string;
  type: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface VaultKey {
  key: string;
  labels?: Record<string, string>;
  hasRefresh?: boolean;
}

export function Vaults() {
  const { request } = useSwamp();
  const { data } = useRequest("vault.search");
  const vaults = extractArray<VaultDef>(data);
  const [selectedVault, setSelectedVault] = useState<string | null>(null);

  return (
    <>
      <div className="page-header">
        <h1>Vaults</h1>
        <div className="header-right">
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {vaults.length} vaults
          </div>
        </div>
      </div>

      {selectedVault
        ? (
          <VaultDetailView
            vaultName={selectedVault}
            onBack={() => setSelectedVault(null)}
          />
        )
        : (
          <div className="card-grid">
            {vaults.map((v) => (
              <div
                className="card"
                key={v.id}
                onClick={() => setSelectedVault(v.name)}
              >
                <div className="card-header">
                  <span className="card-name">{v.name}</span>
                  <span
                    className="cron-badge"
                  >
                    {v.type}
                  </span>
                </div>
              </div>
            ))}
            {vaults.length === 0 && (
              <div className="loading">No vaults configured</div>
            )}
          </div>
        )}
    </>
  );
}

interface AuditEntry {
  timestamp: string;
  action: string;
  key?: string;
  principal?: string;
  [k: string]: unknown;
}

function VaultDetailView(
  { vaultName, onBack }: { vaultName: string; onBack: () => void },
) {
  const { data: descData } = useRequest("vault.describe", {
    vaultNameOrId: vaultName,
  });
  const { data: keysData } = useRequest("vault.list-keys", {
    vaultName,
  });
  const { data: auditData } = useRequest("vault.audit-trail", {
    vaultName,
    limit: 20,
  });

  const vaultInfo = extractObject<VaultDetail>(descData);
  const keys = extractArray<VaultKey>(keysData);
  const auditEntries = extractArray<AuditEntry>(auditData);

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
          <h1>{vaultName}</h1>
          {vaultInfo && <span className="cron-badge">{vaultInfo.type}</span>}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Vault config */}
        {vaultInfo && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Configuration</div>
            </div>
            <div style={{ padding: 0 }}>
              {Object.entries(vaultInfo)
                .filter(([k]) =>
                  k !== "name" && k !== "type" && k !== "id" && k !== "version"
                )
                .map(([key, val]) => (
                  <div key={key}>
                    {typeof val === "object" && val !== null &&
                        !Array.isArray(val)
                      ? (
                        <>
                          <div
                            style={{
                              padding: "8px 18px",
                              background: "var(--surface-inset)",
                              fontSize: "0.78rem",
                              fontWeight: 600,
                              color: "var(--text-2)",
                            }}
                          >
                            {key}
                          </div>
                          {Object.entries(val as Record<string, unknown>).map((
                            [k, v],
                          ) => (
                            <div className="sys-row" style={{ padding: "5px 18px" }} key={k}>
                              <span className="sys-key">{k}</span>
                              <span className="sys-val">{String(v)}</span>
                            </div>
                          ))}
                        </>
                      )
                      : (
                        <div className="sys-row" style={{ padding: "5px 18px" }}>
                          <span className="sys-key">{key}</span>
                          <span className="sys-val">{String(val)}</span>
                        </div>
                      )}
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Keys */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              Keys <span className="panel-count">{keys.length}</span>
            </div>
          </div>
          <div>
            {keys.length === 0 && (
              <div className="loading">No keys stored</div>
            )}
            {keys.map((k) => (
              <div
                key={typeof k === "string" ? k : k.key}
                style={{
                  padding: "8px 18px",
                  borderBottom: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  className="mono"
                  style={{ fontSize: "0.82rem", fontWeight: 500 }}
                >
                  {typeof k === "string" ? k : k.key}
                </span>
                {typeof k === "object" && k.labels && (
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      marginLeft: "auto",
                      flexWrap: "wrap",
                    }}
                  >
                    {Object.entries(k.labels).map(([lk, lv]) => (
                      <span className="cron-badge" key={lk}>
                        {lk}: {lv}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Audit trail */}
        {auditEntries.length > 0 && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                Audit Trail{" "}
                <span className="panel-count">{auditEntries.length}</span>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Key</th>
                    <th>Principal</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry, i) => (
                    <tr key={i}>
                      <td
                        className="mono"
                        style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
                      >
                        {entry.timestamp
                          ? formatRelativeTime(entry.timestamp)
                          : "—"}
                      </td>
                      <td>
                        <span className="cron-badge">{entry.action}</span>
                      </td>
                      <td
                        className="mono"
                        style={{ fontSize: "0.78rem", fontWeight: 500 }}
                      >
                        {entry.key ?? "—"}
                      </td>
                      <td
                        style={{ fontSize: "0.82rem", color: "var(--text-3)" }}
                      >
                        {entry.principal ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
