# The pi-permission-system scope patch

toriel's directory scoping (tickets 163/172) withholds nothing from pi-permission-system's
CONFIG layering: configs merge global -> project -> per-agent, project highest, and a scoped
session's cwd IS the scope root - so a trusted worktree can carry
`.pi/extensions/pi-permission-system/config.json` that re-allows `external_directory_write`
and silently opens the boundary (verified against the real resolver: trusted + escape file =
`allow`; without trust = `ask`). The daemon-owned `TORIEL_SCOPE_ROOT` env cannot see that layer.

The fix is a two-site patch to the installed package (applied 2026-11-09; `toriel doctor`
checks for it as the `permission-package-scope-patch` finding and flags it again after any
package update). In `src/session/permission-session.ts` of the installed
`@gotgenes/pi-permission-system` (find it with `npm root -g` under the node pi runs with;
pi loads the raw `src/` via jiti, so no rebuild step):

Site 1 - `resetForNewSession` (was `configureForCwd(projectTrusted ? ctx.cwd : undefined)`):

```ts
  resetForNewSession(ctx: ExtensionContext, projectTrusted: boolean): void {
    // toriel-scope-patch: a directory-scoped session must not merge project policy - the
    // project layer outranks global and lives INSIDE the scope root, writable by the agent,
    // so a project config could re-allow outside-scope writes. Withhold the project cwd
    // whenever the daemon set a scope root. See toriel pi/patches/scope-config-patch.md.
    const scoped = process.env?.TORIEL_SCOPE_ROOT !== undefined;
    this.permissionManager.configureForCwd(
      scoped || !projectTrusted ? undefined : ctx.cwd,
    );
```

Site 2 - `reload` (was `configureForCwd(projectTrusted ? this.context?.cwd : undefined)`):

```ts
  reload(projectTrusted: boolean): void {
    // toriel-scope-patch: same suppression as resetForNewSession above.
    const scoped = process.env?.TORIEL_SCOPE_ROOT !== undefined;
    this.permissionManager.configureForCwd(
      scoped || !projectTrusted ? undefined : this.context?.cwd,
    );
```

Both patches keep every non-scoped behavior byte-for-byte (no env = the original expression).
Keep a backup of the original file before patching (`.bak-toriel-scope-patch` beside it).
Verified (2026-11-09, real FilePolicyLoader + real PermissionSession): with the env set and a
trusted project escape config on disk, an outside-scope write resolves `ask`; without the env
it resolves `allow` (project config honored where no scope governs - correct).
