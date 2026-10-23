## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Tests

<!-- Run with the isolation variables from CONTRIBUTING.md (SPARROW_HOME, SPARROW_PORT, SPARROW_TMUX_SOCKET,
SPARROW_TMUX_PREFIX, SPARROW_SKILLS_HOME). Paste the real output. -->

```text
bun test test/
```

- [ ] Ran the suite with all isolation variables set (never against `~/.sparrow` or port 4040)
- [ ] Added or updated tests, including the failure path
- [ ] `bun run typecheck` passes
- [ ] For UI changes: `(cd web && bun test test/ && bun run typecheck && bun run lint)` passes

## Screenshots

<!-- Required for UI changes. Before and after. Delete this section otherwise. -->

## Notes

- [ ] No frozen seam changed (`src/shared/*`, `src/cli/client.ts`, `src/harness/index.ts`), or a maintainer agreed
- [ ] Docs updated if behaviour, flags or defaults changed
