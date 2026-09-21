# Releasing

How to publish a new version of MCP Compress Router to npm.

## One-time setup: npm Trusted Publishers

Publishing authenticates through npm Trusted Publishers (OIDC); there
is no `NPM_TOKEN` secret to manage.

1. Open the package's access settings on npmjs.com:
   `https://www.npmjs.com/package/mcp-compress-router/access`.
2. Under *Trusted Publisher*, choose GitHub Actions and configure:
   - Organization or user: `ameshkov`
   - Repository: `mcp-compress-router`
   - Workflow file name: `ci.yml`
   - Environment: leave empty
3. Save. See
   [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) for
   details.

The publish job needs Node.js 24 (npm CLI 11.5.1 or later); the
workflow already pins it.

## Cutting a release

1. Make sure `CHANGELOG.md` is up to date under `[Unreleased]`.
2. Bump the `version` field in `package.json` following
   [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
3. Commit the version bump and tag it with a `v` prefix:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "Release v1.2.3"
   git tag v1.2.3
   ```

4. Push the commit and the tag:

   ```bash
   git push origin master v1.2.3
   ```

5. Watch the
   [CI workflow](https://github.com/ameshkov/mcp-compress-router/actions/workflows/ci.yml).
   The `publish` job verifies that the tag matches `package.json`, runs
   the full quality gate, builds, publishes to npm with provenance, and
   creates a GitHub release with the npm tarball attached.

## Canary releases

Every push to the default branch (`master`) publishes a canary build to
npm's `canary` dist-tag, so unreleased work can be tried without cutting
a release:

```sh
npx mcp-compress-router@canary list
```

The canary job runs only after the quality gate passes. It publishes
`package.json`'s current version with a `-canary.<sha>` prerelease
suffix, so the `canary` tag always resolves to the newest build while
`latest` and the `v*` tag release flow are untouched. An `npm view`
guard skips publishing when that exact version already exists, so
retrying a failed workflow is safe.

Canary publishing uses the same Trusted Publishers entry as releases
(same repository and workflow file), so the one-time setup above covers
both.

## Notes

- The tag version **must** match `package.json` exactly, or the publish
  job fails before releasing anything.
- npm provenance links each published version back to its source commit
  and build.
- Released versions are immutable: if a release is wrong, fix it under
  `[Unreleased]` and ship a new version.
