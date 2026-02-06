// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Text } from "ink";

export interface VersionDisplayProps {
  version: string;
}

export function VersionDisplay({ version }: VersionDisplayProps) {
  return (
    <Text bold color="green">
      swamp {version}
    </Text>
  );
}
