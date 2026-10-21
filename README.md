# MeshCentral Inventory

Inventory and lifecycle management for MeshCentral workstations and peripherals.

## Preview

<p align="center">
  <a href="./docs/screenshots/gallery/workstations-dashboard.png">
    <img src="./docs/screenshots/gallery/workstations-dashboard.png" alt="Inventory workstation dashboard" width="100%">
  </a>
</p>

### Screenshot tour

<table>
  <tr>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/workstations-review-filter.png"><img src="./docs/screenshots/gallery/workstations-review-filter.png" alt="Workstations filtered by review state" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/peripherals-dashboard.png"><img src="./docs/screenshots/gallery/peripherals-dashboard.png" alt="Peripheral inventory dashboard" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/workstation-lifecycle-assignment.png"><img src="./docs/screenshots/gallery/workstation-lifecycle-assignment.png" alt="Workstation lifecycle and assignment details" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/workstation-hardware-identity.png"><img src="./docs/screenshots/gallery/workstation-hardware-identity.png" alt="Workstation hardware identity details" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/peripheral-lifecycle-assignment.png"><img src="./docs/screenshots/gallery/peripheral-lifecycle-assignment.png" alt="Peripheral lifecycle and audit history" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/peripheral-linked-workstation.png"><img src="./docs/screenshots/gallery/peripheral-linked-workstation.png" alt="Peripheral linked workstation details" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/peripheral-actions-menu.png"><img src="./docs/screenshots/gallery/peripheral-actions-menu.png" alt="Inventory actions menu" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/inventory-settings-policy.png"><img src="./docs/screenshots/gallery/inventory-settings-policy.png" alt="Inventory stale-device policy settings" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/inventory-backup-restore.png"><img src="./docs/screenshots/gallery/inventory-backup-restore.png" alt="Inventory backup and restore settings" width="760"></a>
    </td>
    <td width="760" valign="top">
      <a href="./docs/screenshots/gallery/plugin-installed.png"><img src="./docs/screenshots/gallery/plugin-installed.png" alt="Inventory installed in MeshCentral plugins" width="760"></a>
    </td>
  </tr>
</table>

## Features

- Automatically discovers agent-backed workstations.
- Tracks hardware identity by serial number and UUID.
- Shows live agent connectivity and linked MeshCentral records.
- Assigns the first reported user and sends later changes for review.
- Supports manual workstations and peripherals.
- Provides lifecycle states, notes, locations, purchase dates, and warranties.
- Detects missing, stale, duplicate, and conflicting records.
- Includes CSV peripheral import/export, permissions, and audit history.
- Downloads and restores a full, validated Inventory backup.

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

Use **Upgrade** from the Inventory plugin row when MeshCentral reports a newer version. Updating plugin files does not delete inventory records. Full administrators can download or restore Inventory data from **Inventory settings**.

## Development

```powershell
node --test --test-isolation=none
npm run package
```

## License

Apache-2.0
