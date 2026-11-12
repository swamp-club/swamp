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

import { clientSuffix } from "../views/actor_label.ts";

export function ActorWithClient(
  { actor, client, className }: {
    actor: string;
    client?: string;
    className?: string;
  },
) {
  const suffix = clientSuffix(client);
  return (
    <span className={className} title={actor + suffix}>
      {actor}
      {suffix && <span className="client-via">{suffix}</span>}
    </span>
  );
}
