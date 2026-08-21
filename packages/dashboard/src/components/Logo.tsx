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

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const fontSize = size === "lg" ? "2rem" : size === "md" ? "1.4rem" : "1rem";

  return (
    <span
      style={{
        fontFamily: "'Orbitron', sans-serif",
        fontWeight: 900,
        fontSize,
        letterSpacing: "0.1em",
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      <span style={{ color: "#22d3ee" }}>S</span>
      <span style={{ color: "#ec4899" }}>C</span>
    </span>
  );
}
