# @tkl/analyzer-conflicts

Owner: Josue Misael Torres (Knowledge and Traceability).

Detects claims that disagree about the same attribute of the same canonical entity and
records them as `open` conflicts. Conflicts are never auto-resolved — they remain
visible until reviewed, per the workstream acceptance criteria.

## Run tests

```powershell
npm run test --workspace=@tkl/analyzer-conflicts
```
