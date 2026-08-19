import { useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";

interface DataItem {
  name: string;
  modelName?: string;
  type?: string;
  version?: number;
  tags?: Record<string, string>;
  contentType?: string;
}

export function Data() {
  const [modelFilter, setModelFilter] = useState("");
  const payload: Record<string, unknown> = {};
  if (modelFilter) payload.model = modelFilter;

  const { data } = useRequest("data.search", payload);
  const items = extractArray<DataItem>(data);

  const models = [...new Set(items.map((i) => i.modelName).filter(Boolean))];

  return (
    <>
      <div className="page-header">
        <h1>Data</h1>
        <div className="header-right">
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            style={{
              fontFamily: "inherit",
              fontSize: "0.82rem",
              padding: "5px 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--surface)",
              color: "var(--text-1)",
              cursor: "pointer",
            }}
          >
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {items.length} artifacts
          </div>
        </div>
      </div>

      <div className="panel">
        {items.length === 0
          ? <div className="loading">No data artifacts</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Model</th>
                    <th>Type</th>
                    <th>Content Type</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={`${item.name}-${item.modelName}-${i}`}>
                      <td style={{ fontWeight: 500 }}>{item.name}</td>
                      <td
                        className="mono"
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--accent)",
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          item.modelName && setModelFilter(item.modelName)}
                      >
                        {item.modelName ?? "—"}
                      </td>
                      <td
                        style={{ fontSize: "0.82rem", color: "var(--text-3)" }}
                      >
                        {item.type ?? "—"}
                      </td>
                      <td
                        className="mono"
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-3)",
                        }}
                      >
                        {item.contentType ?? "—"}
                      </td>
                      <td
                        className="mono"
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-3)",
                        }}
                      >
                        {item.version ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </>
  );
}
