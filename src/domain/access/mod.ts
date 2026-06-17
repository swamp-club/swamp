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

export {
  type AccessDecision,
  type AccessDecisionService,
  type AccessPrincipal,
  type AccessResource,
} from "./access_decision_service.ts";

export { type Action, ActionSchema } from "./action.ts";

export { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";

export { type ConditionEvaluator, PolicySnapshot } from "./policy_snapshot.ts";

export { PolicySnapshotLoader } from "./policy_snapshot_loader.ts";

export { type PrincipalContext } from "./principal_context.ts";

export { type Effect, EffectSchema } from "./effect.ts";

export {
  type GrantSource,
  GrantSourceSchema,
  parseGrantSource,
} from "./grant_source.ts";

export {
  parsePrincipal,
  type Principal,
  type PrincipalKind,
  PrincipalKindSchema,
  PrincipalSchema,
  principalToString,
} from "./principal.ts";

export {
  parseResourceSelector,
  type ResourceKind,
  ResourceKindSchema,
  type ResourceSelector,
  resourceSelectorMatches,
  ResourceSelectorSchema,
  resourceSelectorToString,
} from "./resource_selector.ts";

export {
  parseSubject,
  type Subject,
  type SubjectKind,
  SubjectKindSchema,
  SubjectSchema,
  subjectToString,
} from "./subject.ts";
