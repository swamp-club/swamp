import { useState } from "react";
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
  const { data } = useRequest("vault.search");
  const vaults = extractArray<VaultDef>(data);
  const [expanded, setExpanded] = useState<string | null>(null);

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

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {vaults.map((v) => (
          <div key={v.id} className="panel">
            <div
              className="panel-header"
              style={{ cursor: "pointer" }}
              onClick={() => setExpanded(expanded === v.name ? null : v.name)}
            >
              <div className="panel-title">
                <span
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--text-3)",
                    transition: "transform 0.15s",
                    display: "inline-block",
                    transform: expanded === v.name
                      ? "rotate(90deg)"
                      : "rotate(0deg)",
                  }}
                >
                  &#9654;
                </span>
                {v.name}
                <span className="cron-badge">{v.type}</span>
              </div>
            </div>
            {expanded === v.name && <VaultExpanded vaultName={v.name} />}
          </div>
        ))}
        {vaults.length === 0 && (
          <div className="loading">No vaults configured</div>
        )}
      </div>
    </>
  );
}

function VaultExpanded({ vaultName }: { vaultName: string }) {
  const { data: descData } = useRequest("vault.describe", {
    vaultNameOrId: vaultName,
  });
  const { data: keysData } = useRequest("vault.list-keys", {
    vaultName,
  });
  const { data: auditData } = useRequest("vault.audit-trail", {
    vaultName,
    limit: 10,
  });

  const vaultInfo = extractObject<VaultDetail>(descData);
  const keys = extractArray<VaultKey>(keysData);
  const auditEntries = extractArray<AuditEntry>(auditData);

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      {/* Config */}
      {vaultInfo && (
        <>
          <SectionHeader title="Configuration" />
          {Object.entries(vaultInfo)
            .filter(([k]) =>
              k !== "name" && k !== "type" && k !== "id" && k !== "version"
            )
            .map(([key, val]) => (
              <div
                className="sys-row"
                style={{ padding: "4px 18px" }}
                key={key}
              >
                <span className="sys-key" style={{ fontSize: "0.78rem" }}>
                  {key}
                </span>
                <span className="sys-val" style={{ fontSize: "0.75rem" }}>
                  {typeof val === "object" ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))}
        </>
      )}

      {/* Keys */}
      <SectionHeader
        title={`Keys (${keys.length})`}
        border={!!vaultInfo}
      />
      {keys.length === 0
        ? (
          <div
            style={{
              padding: "8px 18px 14px",
              fontSize: "0.82rem",
              color: "var(--text-3)",
            }}
          >
            No keys stored
          </div>
        )
        : (
          <div style={{ padding: "0 0 4px" }}>
            {keys.map((k) => {
              const keyName = typeof k === "string" ? k : k.key;
              return (
                <div
                  key={keyName}
                  style={{
                    padding: "6px 18px",
                    borderBottom: "1px solid var(--border-subtle)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: "0.82rem",
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontWeight: 500 }}
                  >
                    {keyName}
                  </span>
                  {typeof k === "object" && k.labels && (
                    <div
                      style={{
                        display: "flex",
                        gap: 4,
                        marginLeft: "auto",
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
              );
            })}
          </div>
        )}

      {/* Audit trail */}
      {auditEntries.length > 0 && (
        <>
          <SectionHeader
            title={`Recent Activity (${auditEntries.length})`}
            border
          />
          {auditEntries.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: "4px 18px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: "0.78rem",
                borderBottom: i < auditEntries.length - 1
                  ? "1px solid var(--border-subtle)"
                  : "none",
              }}
            >
              <span className="cron-badge">{entry.action}</span>
              <span
                className="mono"
                style={{ fontWeight: 500 }}
              >
                {entry.key ?? "—"}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  color: "var(--text-3)",
                  fontSize: "0.72rem",
                }}
              >
                {entry.timestamp ? formatRelativeTime(entry.timestamp) : ""}
              </span>
            </div>
          ))}
        </>
      )}
      <div style={{ height: 8 }} />
    </div>
  );
}

function SectionHeader(
  { title, border = false }: { title: string; border?: boolean },
) {
  return (
    <div
      style={{
        padding: "10px 18px 6px",
        fontSize: "0.7rem",
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 500,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-3)",
        borderTop: border ? "1px solid var(--border-subtle)" : undefined,
      }}
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
