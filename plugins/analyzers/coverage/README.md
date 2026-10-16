# @tkl/analyzer-coverage

Owner: Josue Misael Torres (Knowledge and Traceability).

Computes requirement coverage from canonical knowledge. Per the workstream's acceptance
criteria (`docs/team/TKL-Team-Work-Plan.md`), results always expose their numerator,
denominator, and link confidence — never a bare percentage.

Only approved acceptance-criteria claims contribute to the requirement denominator.
Pending claims remain visible for review, and rejected claims never inflate coverage gaps.

## Run tests

```powershell
npm run test --workspace=@tkl/analyzer-coverage
```
