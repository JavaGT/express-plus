# Entity authorization assembly has a compiler seam

Status: accepted

Entity load-time authorization assembly lives in `compileEntityAuthz`, not inline inside `entity.mjs`. The seven authorization leaves remain separate because they each pass the deletion test, and the registry's two-face engine remains the only source for both SQL row-scope harvest and runtime boolean checks; the new seam only concentrates assembly and testability.