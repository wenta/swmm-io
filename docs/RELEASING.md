# Releasing swmm-io to npm

This repository ships a **prerelease** (`0.8.0-beta.1`). Publication is never performed by tests, pack scripts or dependency installation. This is an experimental file I/O library, not an EPA-approved solver.

## Before the first publish (maintainer tasks)

1. Choose and **check the npm registry package name** (`swmm-io`) with `npm view swmm-io version`. A network/registry error is not proof of availability. If occupied, rename the package and update examples/locks/workflows consistently (consider a personal `@scope/swmm-io`).
2. Create a source repository and set `package.json` fields to the *real* values: `repository` (e.g. `{ "type":"git", "url":"git+https://github.com/OWNER/REPO.git" }`), `homepage`, and `bugs`. They are not filled here because repository ownership/URL was not supplied. Verify repo visibility and licensing before publishing.
3. Confirm you own the name/scope on npm and enable npm 2FA. Choose publication method:
   - **Manual first publish**: authenticate with `npm login` and check `npm whoami`; use `npm publish --tag beta --access public`.
   - **GitHub Actions**: after creating the repository, add an npm **Trusted Publisher** for the exact repository and workflow name `publish-beta.yml`. For a manual workflow, select the version tag and enter `publish-beta` explicitly. That workflow checks that the tag, repo and package metadata match. Trusted publishing requires npm 11.5.1+ and Node.js 22.14+ in the publishing runner; the workflow uses Node 24. This avoids long-lived npm tokens. Refer to https://docs.npmjs.com/trusted-publishers/.
4. Independently review third-party model fixtures and redistribution rights. No third-party fixtures are bundled here.

## Release gate (from project root)

```sh
npm ci
npm run verify
npm run smoke:pack
npm run bench:v08
npm pack --dry-run --json
npm pack
```

Inspect the tarball file list and `tar -tzf swmm-io-0.8.0-beta.1.tgz`. In a clean consumer project, run:

```sh
mkdir ../swmm-release-consumer && cd ../swmm-release-consumer
npm init -y
npm install ../swmm-io-v0.8.0-beta.1/swmm-io-0.8.0-beta.1.tgz
node --input-type=module -e 'import {OutReader, BlobSource, InpModel} from "swmm-io"; console.log(typeof OutReader.open, typeof BlobSource, typeof InpModel.parse)'
```

Use `npm publish --dry-run --tag beta` if your npm CLI supports dry-run for your selected publication mode. Publish from the release **source directory** after tests; use `npm publish --tag beta --access public`. Before publishing, check `npm whoami`, account permissions and any npm policy/2FA requirements. The `package.json` `publishConfig.tag = beta` is a safety net, not a substitute for checking the command. Never pass `--tag latest` for this prerelease.

## After publication

```sh
npm view swmm-io@beta version
npm dist-tag ls swmm-io
npm install swmm-io@beta
```

Verify types and ESM import on another machine. A public version cannot be silently overwritten; increment semver for fixes (`0.8.0-beta.2`, etc.). Never claim full EPA native numeric parity until an independent reference dataset has been used for verification via `tools/compare-reference.mjs`. Synthetic tests and reports of local output parsing are not substitutes for the official Output API.

## Known limitations of this prepared archive

- Package name availability and npm account permissions **could not be independently verified here**.
- The source repository URL is intentionally not invented; npm provenance/trusted publish must be configured once the real URL is known.
- Development dependencies were locked to TypeScript 5.8.3; registry access is required for `npm ci` in a fresh environment.
- The CI workflow is supplied but cannot be exercised until the repository is hosted and the workflow is run.
- Independent native EPA SWMM numerical parity, full browser matrix and multi-gigabyte `.out` stress tests remain open validation work.
