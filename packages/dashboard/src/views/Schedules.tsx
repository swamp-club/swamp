import type { HealthSnapshot } from "../client/useHealthStream";

export function Schedules({ health }: { health: HealthSnapshot | null }) {
  const schedules = health?.scheduling?.schedules ?? [];

  return (
    <>
      <div className="page-header">
        <h1>Schedules</h1>
        <div className="header-right">
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {schedules.length} scheduled workflows
          </div>
        </div>
      </div>

      <div className="panel">
        {schedules.length === 0
          ? <div className="loading">No schedules configured</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Schedule</th>
                    <th>Next Run</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.workflowId}>
                      <td style={{ fontWeight: 500 }}>
                        {s.workflowName ?? s.workflowId}
                      </td>
                      <td>
                        <span className="cron-badge">{s.cronExpression}</span>
                      </td>
                      <td
                        style={{ fontSize: "0.82rem", color: "var(--text-3)" }}
                      >
                        {s.nextRun ? formatRelativeTime(s.nextRun) : "—"}
                      </td>
                      <td>
                        {s.running
                          ? (
                            <span
                              className="mono"
                              style={{
                                fontSize: "0.75rem",
                                color: "var(--running)",
                              }}
                            >
                              running
                            </span>
                          )
                          : (
                            <span
                              className="mono"
                              style={{
                                fontSize: "0.75rem",
                                color: "var(--success)",
                              }}
                            >
                              idle
                            </span>
                          )}
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

function formatRelativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "overdue";
  if (diff < 60000) return "< 1m";
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) {
    return `in ${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`;
  }
  return `in ${Math.floor(diff / 86400000)}d`;
}
