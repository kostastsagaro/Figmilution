# Bridge — Known Limitations

This document tracks fidelity losses, behavioral asymmetries, and unsupported
features in Bridge syncs. It's organized by sync direction because the loss
profile differs significantly between Figma → Illustrator and Illustrator →
Figma.

If you encounter a behavior that's not listed here, please file an issue.
Some of these limitations have known fixes scoped for future milestones; we
note "tracked" where applicable.

---

## Figma → Illustrator

### Effects (M8.5)

**Drop shadow color is not preserved.** Bridge applies AI's "Adobe Drop Shadow"
in darkness mode (color derived from the shape's fill, scaled by 50%). The
explicit color you set in Figma is dropped. A blue shadow on a red shape will
render as a dark red shadow in Illustrator.

*Cause:* Illustrator's Live Effect XML format does not expose a documented way
to inject explicit RGB colors via `applyEffect()`. Color is bundled into a
`/FillStyle` PostScript fragment that we have not yet reverse-engineered.

*Workaround:* If shadow color matters, apply the effect manually in Illustrator
after the sync completes.

*Tracked:* M8.5 Phase C.

**Inner shadow color is not preserved.** Bridge renders Figma's inner shadow as
Illustrator's "Adobe Inner Glow" with default white color. Same root cause as
drop shadow.

**Inner shadow direction (offset) is not preserved.** Illustrator's Inner Glow
is a uniform glow with no directional offset. The X/Y offset you set on a Figma
inner shadow is dropped on the AI side.

*Cause:* Illustrator does not have a directional inner shadow effect. Inner
Glow is the closest equivalent and has no offset parameter.

**Effect blend modes are not preserved.** Multiply, screen, overlay, etc. are
all dropped — Illustrator effects render with AI's default blend modes.

*Cause:* The integer enum mapping AI's `blnd` dictionary key to specific blend
modes has not been decoded.

*Tracked:* M8.5 Phase C.

**Background blur is not supported.** Figma's "background blur" (frosted-glass
effect that blurs what's behind the node) has no Illustrator equivalent.
Background blurs are silently dropped on extraction; you'll see a console
warning naming the affected node.

### Gradients (M6)

**Elliptical radial gradients render as circular.** Figma supports
non-circular radial gradients via its gradient transform matrix. Illustrator
only natively supports circular radials. Bridge approximates ellipticals as
circular (using the average radius) and logs a warning on extraction.

*Workaround:* Use circular radials in Figma if they need to round-trip.

### Fonts

**Fonts must exist on the Illustrator-side machine.** Figma uses cloud fonts;
Illustrator uses fonts installed locally. If a Figma text node uses a font that
Illustrator can't resolve, Bridge falls back to a default. The text content is
preserved but typography may differ visibly.

*Tracked:* upcoming font resolution milestone with project-scoped font mapping.

### Boolean operations

**Boolean operations are flattened on extraction.** Figma's
`BooleanOperationNode` (union, subtract, intersect, exclude) is non-destructive
in Figma but resolved to flat geometry when sent to Bridge. Illustrator
receives a compound path with the resolved shape; the original boolean
operands and operation type are not preserved.

*Workaround:* none. This is an architectural decision (M3 era) — preserving
boolean structure across both apps would require representing it in the IR
and reconstructing it on each side, with limited cross-app fidelity.

### Component variants

**Figma component variants are treated as separate components.** Each variant
becomes its own Illustrator symbol. The variant relationship (which variants
belong to the same parent component, what their property axes are) is not
preserved.

### Z-order (M8)

**On Illustrator, bridge-owned items cluster at the top of layer z-order after
a sync.** User-authored items that were interleaved with bridge-owned items
in z-order will end up below the bridge-owned cluster. The relative order
within each group is preserved.

*Cause:* Illustrator's z-order primitives don't allow bridge-owned items to be
positioned at arbitrary indices relative to user-authored siblings without
much more bookkeeping.

*Workaround:* Manually rearrange after sync; subsequent syncs will respect
your arrangement (until the IR's children order changes).

---

## Illustrator → Figma

### Effects

**Effects are not extracted from Illustrator.** AI → Figma syncs do not
preserve drop shadows, inner glows, or blurs that exist on Illustrator items.
Effects that Bridge previously synced from Figma will remain on the
Illustrator side as Live Effects, but won't propagate back to Figma if you
edit them in Illustrator.

*Cause:* Reading Illustrator's `applyEffect()` XML back out of items is
unreliable across UXP API versions. Phase B was scoped to one-way Figma → AI
only.

*Tracked:* future fidelity milestone, contingent on UXP API improvements or
additional reverse-engineering.

### Color modes

**CMYK colors are converted to RGB approximately on extraction.** If your
Illustrator document is in CMYK color mode, Bridge converts CMYK colors to
RGB using a simple algebraic formula (not an ICC profile). The result is
visually close but not color-accurate. Spot colors are also resolved to their
underlying RGB.

*Workaround:* For color-critical work, keep documents in RGB mode on both sides.

### AI symbol names

**Bridge IDs may not persist on Illustrator symbols.** AI's scripting API
treats some symbol names as read-only depending on how the symbol was created.
When this happens, Bridge logs a warning and the symbol may be re-created on
the next sync (rather than updated in place).

*Tracked:* possible XMP-based fallback for symbol identity tracking.

---

## Both directions

### Containers

**Multi-page Figma documents are flattened to the current page.** Bridge syncs
the active Figma page only. Other pages exist but are not extracted or written.

*Tracked:* multi-page support is on the polish list.

**The pasteboard is treated as a single synthetic container.** Items not on any
artboard (Illustrator) or not in any frame (Figma) are bundled into a single
"Pasteboard" container. Their absolute document positions are preserved within
this container but cross-app pasteboard layout may not be pixel-identical.

### Library reconciliation

**Library entries renamed as orphans are not deleted.** When a color style,
text style, or component is removed from the source app, Bridge does NOT
delete the corresponding asset in the destination app. Instead, it prefixes
the asset name with `[Bridge: orphan]` and removes its bridgeId marker. The
asset remains in the document but is no longer Bridge-managed.

*Rationale:* Style/component deletion can have wide blast radius (every
existing use of the style stops being styled). The orphan-rename approach
gives users a clear visual signal of what's no longer being managed without
risking destructive cascades.

*Workaround:* Manually delete orphaned styles after a sync if you want them
gone.

### Component nesting

**Components cannot contain other component instances.** Bridge's library
reconciliation rejects nested components on extraction. If you have a Figma
component that contains another component as a child, the inner instance will
be treated as flat geometry (its component reference dropped) on the
Illustrator side.

*Tracked:* M5 limitation; recursive component support is a polish item.

### Group child reconciliation

**Groups are full-replaced on update.** When a group's contents change between
syncs, the entire group is rebuilt rather than its children individually
reconciled. This means:

- Manual edits to bridge-owned items inside a group will be lost on the next
  sync that touches that group.
- Group syncs are slower than they could be for partial changes.

*Tracked:* M9+ — recursive group reconciliation using the same plan/executor
abstraction as top-level container reconciliation.

### Concurrent pushes

**A push that arrives while a previous plan is under review is silently
discarded.** Bridge logs a warning to the developer console but does not
display a UI indicator. If you wonder why a push from your collaborator
"didn't arrive," check whether you have an open review panel.

*Tracked:* a "stale plan available — refresh?" UI affordance.

### Stale plans

**Plans don't detect document edits made between plan-time and accept-time.**
If you edit the receiving document while the review panel is open, the plan
may reference items that no longer exist. The executor catches per-op errors
and continues, but partial application is possible.

*Workaround:* Don't edit the receiving document while a review is pending.
Cancel and re-trigger the sync if you do.

---

## Reporting issues

If you hit a fidelity loss not listed here, please include:

- Sync direction (Figma → AI or AI → Figma)
- The IR node type involved (vector, text, image, instance, group)
- A minimal reproduction case (smallest possible Figma/AI selection that
  exhibits the issue)
- Bridge version (visible in the panel)
- Host app versions (Illustrator UXP version, Figma desktop version)

Console output from both the source and destination plugin panels is also
helpful — look for `[Bridge]` log lines.
