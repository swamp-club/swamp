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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";

const H = "\u2500";
const V = "\u2502";
const TT = "\u252C";
const BT = "\u2534";

function VerticalDivider(
  props: { height: number },
): React.ReactElement {
  return (
    <Box flexDirection="column" width={1}>
      {Array.from(
        { length: props.height },
        (_, i) => <Text key={i} color="cyan">{V}</Text>,
      )}
    </Box>
  );
}

export function BrandLine(
  props: { width: number; commandName: string },
): React.ReactElement {
  const { width, commandName } = props;
  const prefix = H;
  const brand = "swamp";
  const suffix = ` ${commandName} ${H}${H}`;
  const fixedLen = prefix.length + brand.length + suffix.length;
  const padLen = Math.max(0, width - fixedLen);
  return (
    <Text>
      <Text color="cyan">{prefix}</Text>
      <Text color="greenBright">{brand}</Text>
      <Text color="cyan">{H.repeat(padLen)}{suffix}</Text>
    </Text>
  );
}

function Separator(
  props: { width: number; junction?: { position: number; char: string } },
): React.ReactElement {
  const { width, junction } = props;
  let line = H.repeat(width);

  if (junction && junction.position >= 0 && junction.position < width) {
    const chars = line.split("");
    chars[junction.position] = junction.char;
    line = chars.join("");
  }

  return <Text color="cyan">{line}</Text>;
}

export interface BorderedSplitLayoutProps {
  width: number;
  resultsWidth: number;
  previewWidth: number;
  contentHeight: number;
  commandName: string;
  promptContent: React.ReactElement;
  resultsContent: React.ReactElement;
  previewContent: React.ReactElement;
  helpContent: React.ReactElement;
}

export function BorderedSplitLayout(
  props: BorderedSplitLayoutProps,
): React.ReactElement {
  const {
    width,
    resultsWidth,
    contentHeight,
    commandName,
    promptContent,
    resultsContent,
    previewContent,
    helpContent,
  } = props;

  const dividerPos = resultsWidth;

  return (
    <Box flexDirection="column" width={width}>
      {/* Branding line */}
      <BrandLine width={width} commandName={commandName} />

      {/* Search prompt */}
      {promptContent}

      {/* Separator with ┬ junction */}
      <Separator
        width={width}
        junction={{ position: dividerPos, char: TT }}
      />

      {/* Content area: results | divider | preview */}
      <Box height={contentHeight} overflow="hidden">
        <Box
          width={resultsWidth}
          height={contentHeight}
          flexDirection="column"
          overflow="hidden"
        >
          {resultsContent}
        </Box>
        <VerticalDivider height={contentHeight} />
        <Box
          flexGrow={1}
          height={contentHeight}
          flexDirection="column"
          overflow="hidden"
        >
          {previewContent}
        </Box>
      </Box>

      {/* Separator with ┴ junction */}
      <Separator
        width={width}
        junction={{ position: dividerPos, char: BT }}
      />

      {/* Help bar */}
      {helpContent}
    </Box>
  );
}

export interface StackedLayoutProps {
  width: number;
  resultsHeight: number;
  previewHeight: number;
  commandName: string;
  promptContent: React.ReactElement;
  resultsContent: React.ReactElement;
  previewContent: React.ReactElement;
  helpContent: React.ReactElement;
}

export function StackedLayout(
  props: StackedLayoutProps,
): React.ReactElement {
  const {
    width,
    resultsHeight,
    previewHeight,
    commandName,
    promptContent,
    resultsContent,
    previewContent,
    helpContent,
  } = props;

  return (
    <Box flexDirection="column" width={width}>
      {/* Branding line */}
      <BrandLine width={width} commandName={commandName} />

      {/* Search prompt */}
      {promptContent}

      {/* Separator */}
      <Separator width={width} />

      {/* Results — height constrained */}
      <Box
        height={resultsHeight}
        width={width}
        flexDirection="column"
        overflow="hidden"
      >
        {resultsContent}
      </Box>

      {/* Separator */}
      <Separator width={width} />

      {/* Preview — height constrained */}
      <Box
        height={previewHeight}
        width={width}
        flexDirection="column"
        overflow="hidden"
      >
        {previewContent}
      </Box>

      {/* Separator */}
      <Separator width={width} />

      {/* Help bar */}
      {helpContent}
    </Box>
  );
}
