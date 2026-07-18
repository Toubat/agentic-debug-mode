# Changesets

This folder holds [changesets](https://github.com/changesets/changesets), which drive the
automated release flow. Each changeset is a small Markdown file describing an intended version
bump.

To add one:

```bash
bun changeset
```

Pick the bump level (`patch`, `minor`, `major`) and write a one-line summary. Commit the generated
file alongside your change. On merge to `main`, the changesets workflow opens a "Version Packages"
pull request; merging that PR tags the release and ships it automatically.
