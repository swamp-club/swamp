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

import { Command } from "@cliffy/command";
import { groupCommandAction } from "../group_action.ts";
import { inviteFirstRuleCommand, inviteLinkCommand } from "./invite_link.ts";

/**
 * The invite group — a pure group, matching the `issue.ts` idiom.
 *
 * An earlier revision carried an optional `[email]` positional that stood in
 * for a per-address email invite. It was removed deliberately: the recruit
 * link may well be enough on its own, and a surface that parses an address
 * only to say "not built yet" advertises something that does not exist.
 * Adding a positional later is additive; withdrawing one people have started
 * scripting against is not.
 *
 * `first-rule` is the same command under a second name, registered hidden — an
 * easter egg, so it is deliberately absent from help and the CLI schema.
 */
export const inviteCommand = new Command()
  .name("invite")
  .description("Invite people to swamp-club")
  .action(groupCommandAction)
  .command("link", inviteLinkCommand)
  .command("first-rule", inviteFirstRuleCommand);
