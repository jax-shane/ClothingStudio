# Contributing

Thank you for wanting to help. Bug reports, ideas, documentation fixes and code are all welcome.

## Reporting a bug

Open an issue and tell us:

1. **What you did**, step by step.
2. **What you expected** and **what happened**. A screenshot helps a lot.
3. Your Windows version and the app version (the folder name / `package.json`).
4. If it is about a pack: the **file names** involved. Please **do not attach other people's paid clothing** or any GTA V game files.

If a file was damaged, do not panic: look for `<name>.ytd.bak` / `<name>.ymt.bak` and the Recycle Bin first ([Troubleshooting](docs/TROUBLESHOOTING.md)).

## Suggesting a feature

Open an issue describing what you are trying to make, not only the button you would like. "I want text along a curve for round
patches" is better than "add warp".

## Working on the code

```bash
git clone <your fork>
cd ClothingStudio
npm install
npm start          # the app
npm test           # 100+ tests, a few seconds, no game files needed
npm run dev        # the UI in a browser (read-only) at http://localhost:5173/renderer/index.html?pack=<folder>
```

Read [docs/TECHNICAL.md](docs/TECHNICAL.md) first; the source map and the safety rules are there.

### Ground rules

- **Never lose a user's files.** Anything that changes a pack goes through `src/lib/packops.js` (plan first, journal every rename, deletes through
  the `trash` callback, `.bak` once, verify before replacing). New operations need tests that include a failure half way.
- **File-format code lives in `src/lib` and must not import Electron**, so it stays testable with plain Node.
- **Tests:** add or update tests for anything in `src/lib`. Use the helpers in `test/helpers.js`; tests must build their own temporary packs and
  must never read the real game, your own packs or the network.
- **The UI** is plain HTML / CSS / JS, no framework or build step. Keep controls big and labelled, with a word and not only an icon; people
  should not need to hover to find out what a button does.
- **Smoke tests.** UI changes should be run in the packaged app with the hooks described in [TECHNICAL.md](docs/TECHNICAL.md#developer-hooks) on a
  *copy* of a pack. They edit the pack they are given.
- **Licence.** The project is GPL-3.0-or-later. By contributing you agree your contribution is under the same licence. Do not paste code from
  projects with an incompatible licence, and do not add game files.
- Keep the changelog ([CHANGELOG.md](CHANGELOG.md)) up to date for user-visible changes.

### Pull requests

- One topic per pull request, with a short description of *why*.
- `npm test` passes. For UI changes, include a screenshot.
- Update the docs in `docs/` if behaviour changes.

## Documentation

Docs are plain Markdown in `docs/`. The screenshots in `docs/images` are produced by the `shots` developer hook (see TECHNICAL.md); retake them
if the UI changes noticeably.
