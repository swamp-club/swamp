// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Text } from "ink";

interface StatusIconProps {
  status:
    | "pending"
    | "waiting"
    | "blocked"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "skipped"
    | "succeeded";
  spinnerFrame?: string;
}

export function StatusIcon({ status, spinnerFrame }: StatusIconProps) {
  switch (status) {
    case "completed":
    case "succeeded":
      return <Text color="green">✓</Text>;
    case "failed":
      return <Text color="red">✗</Text>;
    case "running":
      return <Text color="cyan">{(spinnerFrame ?? "\u280B") + " "}</Text>;
    case "waiting_approval":
      return <Text color="yellow">\u23F8</Text>;
    case "pending":
    case "waiting":
    case "blocked":
      return <Text dimColor>○</Text>;
    case "skipped":
      return <Text dimColor>─</Text>;
  }
}
