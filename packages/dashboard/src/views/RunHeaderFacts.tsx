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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import type { ReactNode } from "react";
import { ActorWithClient } from "../components/ActorWithClient.tsx";

export function Fact(
  { label, children }: { label: string; children: ReactNode },
) {
  return (
    <div className="rd-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function RunByFact(
  { initiatedBy, client }: { initiatedBy: string; client?: string },
) {
  return (
    <Fact label="By">
      <ActorWithClient
        actor={initiatedBy}
        client={client}
        className="rd-by"
      />
    </Fact>
  );
}
