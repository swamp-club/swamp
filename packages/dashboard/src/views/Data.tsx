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

const PAGE_SIZE = 25;

export function Data() {
  const [modelFilter, setModelFilter] = useState("");
  const [page, setPage] = useState(0);
  const payload: Record<string, unknown> = {};
  if (modelFilter) payload.model = modelFilter;

  const { data } = useRequest("data.search", payload);
  const allItems = extractArray<DataItem>(data);

  const models = [...new Set(allItems.map((i) => i.modelName).filter(Boolean))];
  const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
  const items = allItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleModelChange = (m: string) => {
    setModelFilter(m);
    setPage(0);
  };

  return (
    <>
      <div className="page-header">
        <h1>Data</h1>
        <div className="header-right">
          <select
            value={modelFilter}
            onChange={(e) => handleModelChange(e.target.value)}
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
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {allItems.length} artifacts
          </div>
        </div>
      </div>

      <div className="panel">
        {allItems.length === 0
          ? <div className="loading">No data artifacts</div>
          : (
            <>
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
                      <tr key={`${item.name}-${item.modelName}-${page}-${i}`}>
                        <td style={{ fontWeight: 500 }}>{item.name}</td>
                        <td
                          className="mono"
                          style={{
                            fontSize: "0.78rem",
                            color: "var(--accent)",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            item.modelName && handleModelChange(item.modelName)}
                        >
                          {item.modelName ?? "—"}
                        </td>
                        <td
                          style={{
                            fontSize: "0.82rem",
                            color: "var(--text-3)",
                          }}
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

              {totalPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 18px",
                    borderTop: "1px solid var(--border)",
                    fontSize: "0.78rem",
                    color: "var(--text-3)",
                  }}
                >
                  <span>
                    Showing {page * PAGE_SIZE + 1}–
                    {Math.min((page + 1) * PAGE_SIZE, allItems.length)} of{" "}
                    {allItems.length}
                  </span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                      style={{ opacity: page === 0 ? 0.4 : 1 }}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={page >= totalPages - 1}
                      onClick={() => setPage(page + 1)}
                      style={{ opacity: page >= totalPages - 1 ? 0.4 : 1 }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
      </div>
    </>
  );
}
