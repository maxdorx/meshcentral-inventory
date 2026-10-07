# MeshCentral Inventory development guide

## Purpose

This repository contains the `inventory` plugin for MeshCentral. It maintains automatic agent-backed workstation records plus separate manual workstation and peripheral records.

## Code map

- `inventory.js`: MeshCentral hooks, permissions, database access, synchronization, API actions, and navigation integration.
- `lib/model.js`: normalization, validation, identity matching, assignment rules, and audit history.
- `views/inventory.handlebars`: Inventory UI and browser-side behavior.
- `config.json`: MeshCentral plugin manifest and release metadata.
- `test/`: Node test suite for model, server, UI integration, and packaging behavior.
- `scripts/package.ps1`: builds the distributable ZIP in `dist/`.

Inventory records use type `inventoryasset` in MeshCentral's configured database. Plugin upgrades and disabling must preserve these records.

## Required behavior

- Automatic and manual workstations remain separate; never merge an agent into a manual record.
- Manual assets need an explicit authorization scope. Never expose or link assets outside the current user's accessible scope.
- Inventory list operations are read-only. Full synchronization requires `can_sync` or runs as a trusted background task.
- A full domain scan must load/index assets once; do not query the entire asset collection once per node.
- Keep server-side permission checks and input validation on every mutation.
- Keep audit history bounded.
- Modern UI enforcement is intentional while the plugin is enabled. Preserve compatibility with all Modern themes.
- Do not access or modify the production server unless the user explicitly authorizes it.
- Do not modify `C:\Users\Osama\itsupport-portal`.

## Verification

Run before release:

```powershell
node --check inventory.js
node --check lib/model.js
node --test --test-isolation=none
npm.cmd run package
```

Use semantic versions. Publish release artifacts from tested commits, and keep the URL-based installer tied to published release artifacts rather than arbitrary branch contents.

## Plugin download releases

- MeshCentral's **Latest** check reads `configUrl`, but **Upgrade** downloads from the `downloadUrl` saved in the installed plugin record. Changing the remote manifest alone does not repair an older installation's saved URL.
- Keep `config.json`'s `downloadUrl` on the stable `inventory-current` channel. Before calling an upgrade fixed, account for existing installations with a different saved URL: patch only `downloadUrl` in their local `plugins/inventory/config.json`, leave the installed version unchanged, and restart MeshCentral so it refreshes the saved plugin record. Confirm the installed record now shows the expected URL before clicking Upgrade.
- Publish the tested version tag and its ZIP release assets before moving `inventory-current` to the same commit. Verify the channel URL returns HTTP 200 and its downloaded ZIP hash matches the published package. Check the actual download host and redirects; reachability of `raw.githubusercontent.com` does not prove reachability of `codeload.github.com` or GitHub release asset hosts.
- When diagnosing a production timeout, test the saved `downloadUrl` from the MeshCentral server with an HTTPS download. Browser CSP messages and a browser's `/pluginHandler.js` response do not test the server-side plugin download. Do not claim production upgrades work until the installed URL and server-side download have been verified.
