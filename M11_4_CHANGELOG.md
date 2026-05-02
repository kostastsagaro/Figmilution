# M11.4 — Override-aware instance rendering

## Changed files

- `packages/shared/src/bridge-schema.ts`
- `packages/figma-plugin/src/figma-to-ir.ts`
- `packages/ai-plugin/src/ir-to-ai.ts`
- `packages/ai-plugin/src/ai-executor.ts`

## Summary

M11.4 adds typed instance override metadata and a fidelity-first render policy. Clean instances render as Illustrator SymbolItems. Instances with text/fill/visual/deep overrides render as flattened groups when expanded children are available. If no expanded children are available, the renderer places the base symbol with a warning or creates a placeholder when no symbol exists.
