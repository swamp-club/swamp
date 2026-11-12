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

import { celString } from "./data_query_command.ts";

export function specNameClashRemedy(
  modelName: string,
  dataName: string,
  namespace?: string,
): string {
  const ns = namespace !== undefined ? ` && ns == ${celString(namespace)}` : "";
  return `Read it with data.query('modelName == ${celString(modelName)} ` +
    `&& name == ${celString(dataName)}${ns}')[0]. Renaming the data item ` +
    `lasts only if whatever writes "${dataName}" stops writing that name.`;
}
