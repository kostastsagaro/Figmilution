# M11.1 — Component dependency metadata and topological ordering

## Changed files

- `packages/shared/src/bridge-schema.ts`
- `packages/figma-plugin/src/figma-to-ir.ts`
- `packages/ai-plugin/src/ai-planner.ts`

## Summary

Component definitions now carry an optional `dependencies` array listing nested component ids referenced by descendant instance nodes. The Illustrator planner uses this dependency metadata to order component create/update operations child-first, so nested child symbols are planned before parent symbols that reference them.
