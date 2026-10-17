# MeshCentral Inventory

Inventory and lifecycle management for MeshCentral workstations and peripherals.

## Features

- Automatically discovers agent-backed workstations.
- Tracks hardware identity by serial number and UUID.
- Shows live agent connectivity and linked MeshCentral records.
- Assigns the first reported user and sends later changes for review.
- Supports manual workstations and peripherals.
- Provides lifecycle states, notes, locations, purchase dates, and warranties.
- Detects missing, stale, duplicate, and conflicting records.
- Includes CSV peripheral import/export, permissions, and audit history.

## How it works

- Hardware and user data come from MeshCentral node, system-information, and agent events. No extra endpoint collector is installed.
- Inventory records are stored in MeshCentral's configured database and remain separate from MeshCentral node records.
- Automatic workstations are matched by hardware identity, so replacing a MeshCentral node ID does not create a new physical asset.
- The plugin synchronizes once after startup, every six hours, when requested manually, and when relevant agent events arrive. It does not poll every second or minute.
- Permissions and device-group visibility are enforced on the server.

## Requirements

- MeshCentral 1.2.5 or later
- MeshCentral plugins enabled

## Install

1. Open **My Server → Plugins**.
2. Select **Download Plugin**.
3. Enter:

   ```text
   https://raw.githubusercontent.com/maxdorx/meshcentral-inventory/main/config.json
   ```

4. Install Inventory, refresh MeshCentral, and select **Synchronize** for the first scan.

## Permissions

- **View inventory** — view records within the user's MeshCentral scope.
- **Manage inventory** — edit lifecycle, assignments, reviews, and manual records.
- **Synchronize inventory** — run a full synchronization.

Permissions are configured from the Inventory entry under **My Server → Plugins**.

## Updates

Use **Upgrade** from the Inventory plugin row when MeshCentral reports a newer version. Updating plugin files does not delete inventory records. Back up `meshcentral-data` before server or plugin upgrades.

## Development

```powershell
node --test --test-isolation=none
npm run package
```

## License

Apache-2.0
