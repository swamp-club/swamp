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

import { UserError } from "../errors.ts";

/** The data item whose content a query predicate tried to read as text. */
export interface BinaryContentItem {
  modelName: string;
  name: string;
  version: number;
  contentType: string;
}

/**
 * A query predicate read `content` on an item whose content type is not
 * text. `content` in a predicate is text, and binary bytes have none to
 * match against, so the query fails instead of silently skipping the item
 * (swamp-club#2959). A projection may still read the bytes.
 */
export class BinaryContentPredicateError extends UserError {
  constructor(readonly item: BinaryContentItem) {
    super(
      `The query predicate reads content of ${item.modelName}/${item.name} ` +
        `version ${item.version}, whose content type ${item.contentType} is ` +
        "not text (text/*, or a text-based type such as JSON, YAML, XML or " +
        "TOML). Guard the content condition with the content type, for " +
        'example: contentType.startsWith("text/") && content.contains("..."), ' +
        "adding the other text types if they should match too. To read the " +
        "item's bytes, select content and contentEncoding instead; binary " +
        "content is returned base64-encoded.",
    );
    this.name = "BinaryContentPredicateError";
  }
}
