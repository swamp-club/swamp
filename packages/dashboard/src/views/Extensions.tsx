import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";
import { StatusPill } from "../components/StatusPill";

interface ExtensionEntry {
  name: string;
  version: string;
  updateStatus?: string;
  channel?: string;
}

export function Extensions() {
  const { data } = useRequest("extension.list");
  const extensions = extractArray<ExtensionEntry>(data);

  return (
    <>
      <div className="page-header">
        <h1>Extensions</h1>
        <div className="header-right">
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {extensions.length} installed
          </div>
        </div>
      </div>

      <div className="panel">
        {extensions.length === 0
          ? <div className="loading">No extensions installed</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Extension</th>
                    <th>Version</th>
                    <th>Channel</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {extensions.map((ext) => (
                    <tr key={ext.name}>
                      <td style={{ fontWeight: 500 }}>{ext.name}</td>
                      <td>
                        <span className="cron-badge">{ext.version}</span>
                      </td>
                      <td
                        style={{ fontSize: "0.82rem", color: "var(--text-3)" }}
                      >
                        {ext.channel ?? "stable"}
                      </td>
                      <td>
                        <StatusPill
                          status={ext.updateStatus === "update_available"
                            ? "suspended"
                            : "succeeded"}
                        />
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
