# Octane Xplat Tweaks

Live-tweakable values (`useTweak`) for Octane Xplat apps, edited from a desktop
panel, written back to source only on Save.

## Layout

- `packages/tweaks` — `@octane-xplat/tweaks`: runtime hook + shared protocol
  types, plus the Vite plugin at the `./vite` subpath (`src/vite/`, Node only,
  emitted JS to `dist/vite/` via `tsconfig.vite.build.json`; plugin goes
  **before** the Octane plugins). Ships source (`src/`) with
  `web`/`native`/`default` export conditions, like framework leaf packages.
  Hook code lives in `.tsx`.
- `apps/playground` — private web app used for e2e verification.
- `apps/desktop` — private panel app (`@octane-xplat/tweaks-desktop`): shared
  UI for the macOS AppKit renderer (JSC host) and a web build used for e2e.
- `links` — `dev:octane` pnpmfile hook + tests.

## Commands

```sh
pnpm install
pnpm dev:octane        # link framework packages to links/octane-xplat checkout
pnpm dev:published     # revert a dev:octane install back to published packages
pnpm test              # unit tests (node --test, TS type stripping)
pnpm typecheck         # all packages
pnpm build             # tweaks typegen + emit packages/tweaks dist/vite
pnpm --filter playground dev    # playground dev server
pnpm --filter playground test:e2e  # Playwright e2e (needs playwright chromium)
pnpm --filter @octane-xplat/tweaks-desktop dev:web   # panel web build :5211
pnpm --filter @octane-xplat/tweaks-desktop dev       # macOS app via xplat dev
pnpm --filter @octane-xplat/tweaks-desktop build     # packaged .app → artifacts/
pnpm --filter @octane-xplat/tweaks-desktop test:e2e  # panel web e2e
pnpm test:ios            # iOS simulator verification: scaffolds the pinned
                         # create-octane-xplat template into artifacts/ios/,
                         # packs+installs the tweaks packages, applies
                         # fixtures/ios-app, runs xplat dev <UDID> + assertions
                         # (`--app <dir>` reuses a prepared app)
pnpm test:android        # Android emulator verification: same flow into
                         # artifacts/android/ with --targets=android, reusing
                         # fixtures/ios-app; boots the first octane* AVD
                         # (ANDROID_AVD/ANDROID_SERIAL override), runs
                         # xplat dev <serial> + assertions. Self-wraps in a
                         # goddard resource reservation (android:<AVD>)
                         # unless GODDARD_RESOURCE_RESERVATION is set.
```

## Conventions

- pnpm only; exact pins; workspace deps use `workspace:*`.
- `.ts`/`.mts` test and source files must stay erasable-syntax (Node ≥22.18
  type stripping): no enums, namespaces, parameter properties.
- Protocol contract lives in `packages/tweaks/src/protocol.ts`; the plugin and
  the future panel both import it from `@octane-xplat/tweaks/protocol`.

Styles: `src/vite` also extracts static CSS — bamboo `css({…})` calls in
`.ts`/`.tsx` and inline `style={{…}}` in `.tsx`/`.tsrx` — into a style
manifest. Style drafts edit live (inline via `useTweakStyles`/`__tw` from
`@octane-xplat/tweaks/dev`; bamboo via `__twCss` marker classes + a web
MutationObserver leaf) and are written back on Save through `planStyleEdit`.
Bamboo preview compiles drafts through `loadConfigAndCreateContext` in-memory
(optional `@bamboocss/node`, degrades to `preview:'unavailable'`); the native
`__twCss` leaf is a pass-through — bamboo sites mount on web only. Protocol v3 adds `pick`/`picked` for web
click-to-pick (`state.picking`; panel filter via `pickFilter`). Protocol v4
adds `savePreview`: the server runs the same `planSave` the real Save uses and
returns a capped per-file unified diff (`src/vite/diff.ts` renders hunks from
the plan's splices). This remains an optional protocol capability; the desktop
panel saves directly and leaves diff review to the developer's existing tools.
The desktop panel imports shared CSS stylesheets on both AppKit and web.

## Releases

`@octane-xplat/tweaks` publishes from CI via npm trusted publishing (OIDC, no
npm tokens). Modeled on octane-xplat/octane-xplat's flow; same mechanics,
single package.

- `ci.yml` (`CI`): fast checks on PRs and main pushes; a green main push
  records a `ci-evidence-ci-<sha>` artifact that gates everything below.
- `release-pr.yml`: keeps a draft `release/tweaks` PR rebuilt from main after
  every push — Conventional Commit version inference over
  `packages/tweaks/**` (`feat:` minor, `fix:`/`perf:`/`refactor:`/`revert:`
  patch, `!`/`BREAKING CHANGE:` breaking), manifest bump, generated notes.
  Marking the PR ready runs `stable.yml` (pack smoke + both Playwright e2e
  lanes, evidence keyed by tree hash). Merging ships the release.
- `release.yml`: on each green main CI run, publishes a merged release —
  immediately if its tree is already qualified, else after running
  `stable.yml` inline on the merge commit. Also publishes
  `0.0.0-nightly.g<sha7>` on a daily schedule under npm's `nightly` dist-tag
  when publishable paths changed since the published nightly.
- The GitHub Release is the completion marker: a tag without its release is
  an unfinished publish, resumed from the tag on the next green run. Between
  merge and tag the release is pending and the release PR is not rebuilt.
- `packages/tweaks` version `0.0.0` means "never released — nothing pending."
  Only the release workflow sets a real version (on the release branch); do
  not bump it by hand — a nonzero untagged version reads as a merged release
  awaiting publication and ships on the next green main run.
- Release notes are generated from commits since the previous `v*` tag (no
  `.changelog` convention); `pnpm test` covers the release scripts.
- `test:ios`/`test:android` device verification stays local — no simulator or
  emulator lanes run on hosted runners.
- Pushes, tags, and PR writes use the `RELEASE_TOKEN` secret (fine-grained
  PAT: Contents, Pull requests, Workflows read/write) so `pull_request`
  workflows trigger.

Manual bootstrap before the first publish (one-time, needs an npm maintainer
token): publish a minimal `0.0.1` stub under the final name —
`npm publish <stub-dir> --access public` — then bind the trusted publisher:

```sh
npm trust github @octane-xplat/tweaks --file release.yml \
  --repository octane-xplat/tweaks --allow-publish --allow-stage-publish
```
