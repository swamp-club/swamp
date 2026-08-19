import type { HealthSnapshot } from "../client/useHealthStream";

export function Webhooks({ health }: { health: HealthSnapshot | null }) {
  const webhooks = health?.webhooks ?? [];

  return (
    <>
      <div className="page-header">
        <h1>Webhooks</h1>
        <div className="header-right">
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {webhooks.length} endpoints
          </div>
        </div>
      </div>

      <div className="panel">
        {webhooks.length === 0
          ? <div className="loading">No webhooks configured</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Workflow</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((w) => (
                    <tr key={w.route}>
                      <td>
                        <span className="mono" style={{ fontSize: "0.82rem" }}>
                          {w.route}
                        </span>
                      </td>
                      <td style={{ fontWeight: 500 }}>{w.workflow}</td>
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
