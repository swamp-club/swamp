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

/**
 * the dashboard's door into core's Swampify contracts, beside record.ts; the
 * page imports these names from here, never from src/ directly
 */

export {
  newestSwampifyItem,
  readSwampifyCandidateSet,
  readSwampifyCandidateSetSummary,
  readSwampifyComparison,
  readSwampifyComparisonSummary,
  readSwampifyOffer,
  readSwampifyOfferSummary,
  SWAMPIFY_BEHAVIOR_NAME,
  SWAMPIFY_CANDIDATES_DATA_NAME,
  SWAMPIFY_CANDIDATES_QUERY_PREDICATE,
  SWAMPIFY_COMPARISON_QUERY_PREDICATE,
  SWAMPIFY_GENERATED_AT_TAG,
  SWAMPIFY_LIST_SELECT,
  SWAMPIFY_OFFER_DATA_NAME,
  SWAMPIFY_OFFER_QUERY_PREDICATE,
  SWAMPIFY_OPTION_ID_TAG,
  SWAMPIFY_SUMMARY_TAG,
  SWAMPIFY_UPDATED_AT_TAG,
  swampifyComparisonDataName,
  swampifyComparisonPredicate,
} from "../../../../../src/domain/agent_sessions/swampify.ts";
export type {
  SwampifyCandidate,
  SwampifyCandidateSet,
  SwampifyCandidateSetReading,
  SwampifyCandidateSetSummary,
  SwampifyComparison,
  SwampifyComparisonReading,
  SwampifyComparisonSummary,
  SwampifyListRow,
  SwampifyOffer,
  SwampifyOfferOption,
  SwampifyOfferReading,
  SwampifyOfferState,
  SwampifyOfferSummary,
  SwampifyRange,
  SwampifySkipped,
  SwampifySkipReason,
} from "../../../../../src/domain/agent_sessions/swampify.ts";
