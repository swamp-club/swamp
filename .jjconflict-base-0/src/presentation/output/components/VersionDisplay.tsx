// deno-lint-ignore verbatim-module-syntax
import React, { Fragment } from "react";
import { Box, Newline, Text } from "ink";

export interface VersionDisplayProps {
  version: string;
  haiku: string;
}

export function VersionDisplay({ version, haiku }: VersionDisplayProps) {
  const haikuLines = haiku.split("\n");

  return (
    <Box flexDirection="column">
      <Text bold color="green">
        swamp v{version}
      </Text>
      <Box paddingLeft={2}>
        <Text color="cyan" italic>
          {haikuLines.map((line, index) => (
            <Fragment key={index}>
              {line}
              {index < haikuLines.length - 1 && <Newline />}
            </Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
