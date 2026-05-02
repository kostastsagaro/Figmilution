# M10.3 / M10.4 / M10.5 — Illustrator Gradient Color Styles

## What changed

- Added reusable Illustrator gradient resource helpers in `packages/ai-plugin/src/ir-to-ai.ts`.
- Updated color style creation/application so solid styles continue to use spot-like resources, while gradient styles use `doc.gradients`.
- Updated vector fill application to prefer a linked library gradient resource when `paint.styleId` resolves, while preserving inline-gradient fallback.
- Updated Illustrator planning in `packages/ai-plugin/src/ai-planner.ts` so existing gradient resources with Bridge color-style markers are indexed alongside swatches.
- Updated executor color style update handling in `packages/ai-plugin/src/ai-executor.ts` so a style resource can be replaced when its kind changes between solid and gradient.

## Notes

The node paint remains self-contained. The library gradient stores the reusable ramp; each node paint still supplies object-specific geometry.
