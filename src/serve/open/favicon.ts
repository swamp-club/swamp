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

// Favicon sourced from swamp-club (static/favicon.svg) — embedded as a string
// so the compiled swamp binary can serve it without filesystem access.
export const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <filter id="glow">
      <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="blur1" />
      <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur2" />
      <feMerge>
        <feMergeNode in="blur2" />
        <feMergeNode in="blur1" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <clipPath id="top-half">
      <rect x="0" y="0" width="64" height="35" />
    </clipPath>
    <clipPath id="bottom-half">
      <rect x="0" y="29" width="64" height="35" />
    </clipPath>
  </defs>
  <g filter="url(#glow)" opacity="0.45">
    <path
      d="M202 0Q162 0 128.0 20.0Q94 40 74.0 74.0Q54 108 54 148V215H209V156Q209 156 209.0 156.0Q209 156 209 156H617Q617 156 617.0 156.0Q617 156 617 156V282Q617 282 617.0 282.0Q617 282 617 282H202Q162 282 128.0 302.0Q94 322 74.0 355.5Q54 389 54 430V572Q54 613 74.0 646.5Q94 680 128.0 700.0Q162 720 202 720H626Q666 720 699.5 700.0Q733 680 753.5 646.5Q774 613 774 572V505H617V564Q617 564 617.0 564.0Q617 564 617 564H209Q209 564 209.0 564.0Q209 564 209 564V438Q209 438 209.0 438.0Q209 438 209 438H626Q666 438 699.5 418.0Q733 398 753.5 364.5Q774 331 774 290V148Q774 108 753.5 74.0Q733 40 699.5 20.0Q666 0 626 0Z"
      transform="translate(3.00,44.28) scale(0.034118,-0.034118)"
      fill="#39ff14"
    />
    <path
      d="M204 0Q163 0 129.5 20.0Q96 40 76.0 73.5Q56 107 56 148V572Q56 613 76.0 646.5Q96 680 129.5 700.0Q163 720 204 720H774V564H244Q228 564 219.5 556.0Q211 548 211 531V189Q211 173 219.5 164.5Q228 156 244 156H774V0Z"
      transform="translate(32.96,44.28) scale(0.034118,-0.034118)"
      fill="#39ff14"
    />
  </g>
  <g clip-path="url(#top-half)" opacity="0.9">
    <path
      d="M202 0Q162 0 128.0 20.0Q94 40 74.0 74.0Q54 108 54 148V215H209V156Q209 156 209.0 156.0Q209 156 209 156H617Q617 156 617.0 156.0Q617 156 617 156V282Q617 282 617.0 282.0Q617 282 617 282H202Q162 282 128.0 302.0Q94 322 74.0 355.5Q54 389 54 430V572Q54 613 74.0 646.5Q94 680 128.0 700.0Q162 720 202 720H626Q666 720 699.5 700.0Q733 680 753.5 646.5Q774 613 774 572V505H617V564Q617 564 617.0 564.0Q617 564 617 564H209Q209 564 209.0 564.0Q209 564 209 564V438Q209 438 209.0 438.0Q209 438 209 438H626Q666 438 699.5 418.0Q733 398 753.5 364.5Q774 331 774 290V148Q774 108 753.5 74.0Q733 40 699.5 20.0Q666 0 626 0Z"
      transform="translate(3.00,44.28) scale(0.034118,-0.034118)"
      fill="#22d3ee"
    />
    <path
      d="M204 0Q163 0 129.5 20.0Q96 40 76.0 73.5Q56 107 56 148V572Q56 613 76.0 646.5Q96 680 129.5 700.0Q163 720 204 720H774V564H244Q228 564 219.5 556.0Q211 548 211 531V189Q211 173 219.5 164.5Q228 156 244 156H774V0Z"
      transform="translate(32.96,44.28) scale(0.034118,-0.034118)"
      fill="#22d3ee"
    />
  </g>
  <g clip-path="url(#bottom-half)" opacity="0.9">
    <path
      d="M202 0Q162 0 128.0 20.0Q94 40 74.0 74.0Q54 108 54 148V215H209V156Q209 156 209.0 156.0Q209 156 209 156H617Q617 156 617.0 156.0Q617 156 617 156V282Q617 282 617.0 282.0Q617 282 617 282H202Q162 282 128.0 302.0Q94 322 74.0 355.5Q54 389 54 430V572Q54 613 74.0 646.5Q94 680 128.0 700.0Q162 720 202 720H626Q666 720 699.5 700.0Q733 680 753.5 646.5Q774 613 774 572V505H617V564Q617 564 617.0 564.0Q617 564 617 564H209Q209 564 209.0 564.0Q209 564 209 564V438Q209 438 209.0 438.0Q209 438 209 438H626Q666 438 699.5 418.0Q733 398 753.5 364.5Q774 331 774 290V148Q774 108 753.5 74.0Q733 40 699.5 20.0Q666 0 626 0Z"
      transform="translate(3.00,44.28) scale(0.034118,-0.034118)"
      fill="#ec4899"
    />
    <path
      d="M204 0Q163 0 129.5 20.0Q96 40 76.0 73.5Q56 107 56 148V572Q56 613 76.0 646.5Q96 680 129.5 700.0Q163 720 204 720H774V564H244Q228 564 219.5 556.0Q211 548 211 531V189Q211 173 219.5 164.5Q228 156 244 156H774V0Z"
      transform="translate(32.96,44.28) scale(0.034118,-0.034118)"
      fill="#ec4899"
    />
  </g>
  <g opacity="0.25">
    <path
      d="M202 0Q162 0 128.0 20.0Q94 40 74.0 74.0Q54 108 54 148V215H209V156Q209 156 209.0 156.0Q209 156 209 156H617Q617 156 617.0 156.0Q617 156 617 156V282Q617 282 617.0 282.0Q617 282 617 282H202Q162 282 128.0 302.0Q94 322 74.0 355.5Q54 389 54 430V572Q54 613 74.0 646.5Q94 680 128.0 700.0Q162 720 202 720H626Q666 720 699.5 700.0Q733 680 753.5 646.5Q774 613 774 572V505H617V564Q617 564 617.0 564.0Q617 564 617 564H209Q209 564 209.0 564.0Q209 564 209 564V438Q209 438 209.0 438.0Q209 438 209 438H626Q666 438 699.5 418.0Q733 398 753.5 364.5Q774 331 774 290V148Q774 108 753.5 74.0Q733 40 699.5 20.0Q666 0 626 0Z"
      transform="translate(3.00,44.28) scale(0.034118,-0.034118)"
      fill="white"
    />
    <path
      d="M204 0Q163 0 129.5 20.0Q96 40 76.0 73.5Q56 107 56 148V572Q56 613 76.0 646.5Q96 680 129.5 700.0Q163 720 204 720H774V564H244Q228 564 219.5 556.0Q211 548 211 531V189Q211 173 219.5 164.5Q228 156 244 156H774V0Z"
      transform="translate(32.96,44.28) scale(0.034118,-0.034118)"
      fill="white"
    />
  </g>
</svg>
`;
