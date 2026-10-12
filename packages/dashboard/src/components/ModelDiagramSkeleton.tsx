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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Skeleton, SkeletonRegion, widthAt } from "./Skeleton.tsx";

function SkeletonBoxes({ count, offset }: { count: number; offset: number }) {
  return (
    <div className="mds-col">
      <Skeleton width={72} height={9} />
      {Array.from({ length: count }, (_, i) => (
        <div className="mds-box" key={i}>
          <Skeleton width={12} height={12} radius={3} />
          <span className="mds-lines">
            <Skeleton width={widthAt(i + offset)} height={10} />
            <Skeleton width="38%" height={8} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The model diagram's placeholder: input boxes, the model card and output
 * boxes in the diagram's own arrangement, stacking on narrow screens.
 */
export function ModelDiagramSkeleton() {
  return (
    <SkeletonRegion label="Loading model" className="mds">
      <SkeletonBoxes count={4} offset={0} />
      <div className="mds-model">
        <Skeleton width={180} height={20} radius={4} />
        <div className="mds-card">
          <Skeleton width="45%" height={10} />
          <Skeleton width="70%" height={16} />
          <span style={{ display: "flex", gap: 6 }}>
            <Skeleton width={34} height={16} radius={4} />
            <Skeleton width={64} height={10} style={{ marginTop: 3 }} />
          </span>
        </div>
      </div>
      <SkeletonBoxes count={3} offset={3} />
    </SkeletonRegion>
  );
}
