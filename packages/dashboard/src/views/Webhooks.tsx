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
