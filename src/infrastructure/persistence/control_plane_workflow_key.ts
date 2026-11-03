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

import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";

/**
 * the id is percent-encoded so none can name a key outside the prefix;
 * characters encodeURIComponent leaves alone are encoded too, as a Windows
 * filesystem control plane can't hold *
 */
export function workflowKey(prefix: string, workflowId: WorkflowId): string {
  const encoded = encodeURIComponent(workflowId).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${prefix}${encoded}`;
}

export function workflowIdOfKey(
  prefix: string,
  key: string,
): WorkflowId | null {
  const at = key.lastIndexOf(prefix);
  if (at === -1) return null;
  const encoded = key.slice(at + prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) return null;
  try {
    return createWorkflowId(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}
