# Updating and releasing

This is a private mirror, so in-app updating is off (`UPDATE_CHECK_ENABLED=false`).
A private repo returns 404 to unauthenticated clients on all three update endpoints —
`raw.githubusercontent.com`, the `api.github.com` fallback, and release-asset downloads —
so every in-app update path would fail regardless. Updating is a manual rebuild.

## Updating the machine that runs the bot

```bash
git pull
npm install          # only when package.json changed
npm run build:exe
```

Then stop and start the bot from the Control Panel. The build writes `dist/`, plus
`MonitorPokemon.zip` and `MonitorPokemon-assets.zip` at the repo root.

Requirements: Node 22+, and `csc.exe` from the .NET Framework that ships with Windows
(`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). If `csc.exe` is missing the
build skips the Control Panel and prints a warning rather than failing.

## Cutting a release (only needed to distribute to another PC)

```bash
npm run build:exe
gh release create vX.Y.Z -R chefhousgit/Pokemon-Monitor-TCGP --target main \
  dist/MonitorPokemon.exe dist/MonitorPokemonPanel.exe \
  MonitorPokemon.zip MonitorPokemon-assets.zip
```

Bump `version` in `version.json` first and keep the tag equal to it, or the version
comparison will misreport. **Always pass `-R chefhousgit/...`** — this clone still has an
`upstream` remote pointing at the original author, and `gh` picks a remote on its own
otherwise.

## If you ever make the repo public

Set `UPDATE_CHECK_ENABLED=true` in `.env` and everything works again with no code changes:
`UPDATE_REPO` already points here, and download URLs are validated against it before
anything is executed. Nothing needs to be re-pointed.

## Notes

- `upstream` has its push URL disabled on purpose, so a stray `git push upstream` fails
  instead of attempting to write to the original author's repo.
- `.env` is gitignored; `.env.example` documents every variable.
