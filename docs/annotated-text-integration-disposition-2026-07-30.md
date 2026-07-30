# Annotated Text Integration Disposition

Base: `710175465c6f1e90875823a33dd152727d295d15` (`main`) on 2026-07-30.
This register deliberately makes no source cherry-picks. The branch is an
integration record only: the active tombstone frontier remains exclusively on
`main` until its owner lands it.

| Branch | Tip | Disposition | Evidence / successor |
| --- | --- | --- | --- |
| `annotated-text-r3-merge` | `2f0f32d` | merged | Ancestor of base; R3 runtime is already present. |
| `annotated-text-r4-annotation-apply` | `55c90b4` | merged | Ancestor of base, including R4 and the shutdown fix. |
| `annotated-text-t1` | `c1f6e72` | rejected | Unique `assertTextOpSyntax` is a second, weaker grammar beside current closed `assertTextOp`; it also changes durable v1 Lamport admission. No safe replay. |
| `annotated-text-t1-anchor-semantics` | `25e5d6d` | merged | Ancestor of base; its anchor rules are retained in ADR 0005. |
| `annotated-text-t2` | `0713657` | rejected WIP | Commit explicitly says WIP and supplies an alternate reducer/checkpoint API. Its own recovery test records pending work loss on restore; retaining it would create a hybrid reducer. |
| `annotated-text-t2-amended` | `9847775` | merged | Ancestor of base; R2 split runtime was superseded by the R3 merge path. |
| `annotated-text-t2-rebuild` | `16b11ec` | superseded | Current main contains the accepted reducer lineage (`42b2f77` and successors) with the sole canonical field-cell checkpoint. This prototype has incompatible checkpoint shape and adds no missing accepted behavior. |
| `origin/annotated-text-t3` | `4afd9cf` | merged | Ancestor of base through R3 (`2f0f32d`). No local branch ref exists. |
| `annotated-text-t5a-recipient-projection` | `c234d505` | merged | Ancestor of base. Its published remote predecessor `16448c3` is also an ancestor; recipient projection successors are already on main. |
| `runtime-node-compat-cleanup` | `adcaf97` | merged but excluded | Ancestor of base through T5a; it is not part of the annotated-text integration change. |

## Proof and boundary

- `git merge-base --is-ancestor` proves every row marked merged is contained by
  the base. `git log --left-right --cherry-pick` shows the three excluded tips
  are not patch-equivalent to the later accepted lineage.
- `docs/adr/0005-annotated-text-kernel.md` fixes one closed grammar and one
  reducer. `docs/annotated-text-t2-boundary.md` fixes `src/annotated-text.mjs`
  as the sole shared reducer and the declared field cell as its sole durable
  checkpoint. The rejected/replaced branches must therefore remain refs, not
  be replayed piecemeal.
