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

import type { Data } from "../data/data.ts";
import type { ModelType } from "../models/model_type.ts";

export interface StoredReportData {
  data: Data;
  modelType: ModelType;
  modelId: string;
}

export interface StoredReportOwner {
  type: ModelType;
  modelId: string;
}

/**
 * may return data of other owners, which callers drop, but must return every
 * report
 */
export type FindStoredReports = (
  owner?: StoredReportOwner,
) => Promise<StoredReportData[]>;
