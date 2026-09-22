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

interface PagerProps {
  /** Zero-based current page. */
  page: number;
  pageSize: number;
  /** Total matches reported by the server. */
  total: number;
  onPageChange: (page: number) => void;
}

/** Footer pager for server-paged tables; renders nothing for a single page. */
export function Pager({ page, pageSize, total, onPageChange }: PagerProps) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  return (
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
        Showing {page * pageSize + 1}–
        {Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          className="btn-sm"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          style={{ opacity: page === 0 ? 0.4 : 1 }}
        >
          Previous
        </button>
        {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
          let p = i;
          if (totalPages > 7) {
            if (page < 4) p = i;
            else if (page > totalPages - 4) p = totalPages - 7 + i;
            else p = page - 3 + i;
          }
          return (
            <button
              type="button"
              key={p}
              onClick={() => onPageChange(p)}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.72rem",
                padding: "4px 8px",
                border: "1px solid var(--border)",
                borderRadius: 4,
                background: p === page ? "var(--accent-subtle)" : "transparent",
                color: p === page ? "var(--accent)" : "var(--text-3)",
                cursor: "pointer",
              }}
            >
              {p + 1}
            </button>
          );
        })}
        <button
          type="button"
          className="btn-sm"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
          style={{ opacity: page >= totalPages - 1 ? 0.4 : 1 }}
        >
          Next
        </button>
      </div>
    </div>
  );
}
