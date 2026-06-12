# Notes for Claude

## Workflow
- Always auto-merge changes: after pushing a branch and opening a PR, mark it
  ready and squash-merge it immediately — don't wait for the user to ask.

## Project quickstart
- `npm start` runs the server (`server/index.js`) on port 8080.
- `node tools/smoke-test.js` is the test suite; run it before pushing.
- `python3 tools/build-assets.py` regenerates `client/assets/` (needs
  pillow + numpy); generated atlases are committed. Hand-edited art lives
  in `art/overrides/` and is stamped on top of every rebuild — see
  `art/README.md` (`--export` dumps editable copies + grid guides).
- Art licensing: see `client/assets/CREDITS.md` — never use actual
  Ultima Online assets (EA copyright); free-licensed art only.
