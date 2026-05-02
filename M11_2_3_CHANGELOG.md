# M11.2 / M11.3 — Nested instance rendering and dependent rebuild propagation

## Changed files

- `packages/shared/src/bridge-schema.ts`
- `packages/ai-plugin/src/ir-to-ai.ts`
- `packages/ai-plugin/src/ai-executor.ts`
- `packages/ai-plugin/src/ai-planner.ts`

## Summary

Nested instance rendering now attempts to place child Illustrator symbols when a component definition is being built. Component symbols are created from staging groups, and parent components can contain placed child SymbolItems. The planner also now includes transitive-dependent dirty expansion so changed child components force parent components to rebuild in child-first topological order.
