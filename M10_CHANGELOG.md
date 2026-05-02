# M10.1 / M10.2 Gradient Color Style Snapshot

## What changed

- Added `BridgePaintBase` in `packages/shared/src/bridge-schema.ts`.
- Moved common paint fields (`opacity`, `visible`, `styleId`) onto the shared paint base.
- Updated `packages/figma-plugin/src/figma-to-ir.ts` so Figma paint styles can extract solid, linear gradient, and radial gradient library styles.
- Added graceful handling for angular and diamond gradient paint styles by approximating them through the existing first-stop solid fallback.
- Updated Figma fill extraction so the first generated paint receives `styleId` regardless of whether it is solid or gradient.
- Preserved the accepted M9 font resolution files in this full repository snapshot.

## Scope

This snapshot prepares the IR and Figma extraction side for gradient library styles. Illustrator-side reusable gradient swatch creation/application remains the next milestone.
