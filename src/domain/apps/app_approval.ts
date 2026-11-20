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

import { z } from "zod";
import { AppNameSchema } from "./app_descriptor.ts";

export const AppApprovalSchema = z.object({
  name: AppNameSchema,
  capabilityKey: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),
});

export type AppApproval = z.infer<typeof AppApprovalSchema>;

export interface AppApprovalRepository {
  get(name: string): Promise<AppApproval | null>;
  save(approval: AppApproval): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** `changed`: an approval exists for a different capability set, so the app stays off. */
export type AppState = "pending" | "enabled" | "changed";

export function appState(
  capabilityKey: string,
  approval: AppApproval | null,
): AppState {
  if (approval === null) return "pending";
  return approval.capabilityKey === capabilityKey ? "enabled" : "changed";
}
