# Changelog

## 1.2.2 - 2026-10-08

- Restored non-administrator visibility for unlinked peripherals by assigning them an explicit domain authorization scope. Workstation-linked peripherals continue to inherit the workstation's device-group visibility.
- Added a trusted-scan migration for peripheral records created before explicit scopes were introduced.

## 1.2.1 - 2026-10-07

- Fixed the URL installer to use a stable release-channel tag and a directly served ZIP on `raw.githubusercontent.com`. MeshCentral keeps the installed `downloadUrl` for Upgrade, so version-pinned URLs could not advance to a newer release.
- Added the identical fixed-name ZIP to the tested release commit and published release assets. The release-channel tag is moved only after the immutable version tag and GitHub release are published.

## 1.2.0 - 2026-10-07

- Added a domain-wide ignored sign-in account list under Inventory settings. Plain usernames match domain-qualified and UPN reports; qualified entries match exactly.
- Prevented ignored accounts from becoming automatic assignees or signed-in user reviews. Saving the list clears matching pending reviews and agent-derived assignments while keeping manual assignments and bounded audit history.
- Reduced the Inventory page heading and removed repeated Workstations/Peripherals headings, descriptions, and the duplicate detail back button to leave more room for the device list.

## 1.1.2 - 2026-10-06

- Changed the URL installer to the immutable GitHub tag archive so MeshCentral deployments whose outbound filtering blocks GitHub's Release Assets host can download updates through `codeload.github.com`.
- Kept the installer pinned to the tested release tag rather than mutable branch contents.

## 1.1.1 - 2026-10-06

- Expanded the Inventory dashboard and detail views to use the full remaining MeshCentral viewport and full iframe width.
- Replaced nested document scrolling with one intentional asset-list scrollbar and one detail-view scrollbar.
- Extended the toolbar and inventory table to the viewport edges while retaining responsive gutters across Modern themes.
- Restored MeshCentral's original shared plugin-frame sizing whenever Inventory is closed or another plugin takes ownership.

## 1.1.0 - 2026-10-06

- Added manual user assignment to every workstation, including agent-backed Macs that report no signed-in user. Manual assignments retain their source and generate an audit event.
- Added one-time reviews for Assigned workstations with no assignee, stale agents, missing MeshCentral nodes, and archived agents that return.
- Added configurable stale detection. It follows device-group or domain removal settings by default and uses 30 days when auto-removal is disabled; administrators can choose a custom threshold or disable stale detection.
- Added review actions to acknowledge an offline cycle, snooze, archive, retire, and restore archived records. Archived records have a separate view and do not count as active.
- Kept list requests read-only and confined stale evaluation to trusted synchronization and scheduled scans.

## 1.0.1 - 2026-10-05

- Scoped manual inventory visibility to full administrators or the linked workstation's accessible device group.
- Prevented peripheral linking and validation responses from exposing inaccessible workstation records.
- Made dashboard list requests read-only; synchronization now requires the explicit permission or runs at trusted startup/agent hooks.
- Loaded and indexed inventory records once per full synchronization instead of once per node.
- Serialized all inventory mutations and applied consistent server-side date validation.
- Changed URL installations to a fixed-name asset from the latest published GitHub release while retaining versioned release archives.
- Kept the intentional Modern UI enforcement unchanged.

## 1.0.0 - 2026-10-05

- First stable public release.
- Added automatic workstation inventory, reviewed user assignment, manual peripheral inventory, CSV import/export, lifecycle management, audit history, filters, pagination, and Modern UI theme support.
- Added separate manual workstation entry, cross-source duplicate prevention and review, and restart-safe no-agent records.
- Added a standard MeshCentral plugin manifest for URL installation and future version checks.

## 0.2.3 - 2026-10-04

- Recovered Inventory after refresh when MeshCentral restores shared plugin page 43 but the explicit plugin marker is absent, using Inventory's tab or asset route as a safe fallback.
- Watched the shared page-43 iframe so opening a different server plugin clears Inventory's URL markers, heading, and selected navigation state.
- Kept MeshCentral's internal `urlargs` route state synchronized with visible Inventory URLs so navigation cannot reinsert stale plugin, tab, asset, or Modern-UI bridge parameters.

## 0.2.2 - 2026-10-04

- Added contrast-aware accent selection so themes such as Lux remain readable when their primary color matches the dark background.
- Clicking the main Inventory navigation now always opens the dashboard; only a browser refresh preserves an already-open asset detail.
- Leaving Inventory now removes the asset-detail URL marker, preventing stale detail restoration after visiting other MeshCentral pages.
- Isolated response routing between the dashboard iframe and per-device Inventory iframes so one frame cannot open details, stop loading, or display results requested by another frame.
- Added collision-resistant per-frame request identifiers and ignored late responses from superseded list retries.
- Reloaded a reused per-device Inventory iframe when MeshCentral navigates directly to a different endpoint, preventing stale details from the prior node.

## 0.2.1 - 2026-10-04

- Enforced MeshCentral's complete Modern UI while Inventory is enabled, including a one-time migration for users whose saved interface is Classic.
- Hid only the Classic/Modern selector while leaving every Modern Bootswatch and light/dark theme selectable.
- Synchronized Inventory's semantic foreground, background, accent, border, muted, and surface colors after every Modern theme stylesheet load.
- Kept the policy reversible: disabling the plugin and refreshing restores MeshCentral's standard UI selector without changing the server domain configuration.

## 0.2.0 - 2026-10-04

- Split the dashboard into Workstations and Peripherals without changing automatic workstation synchronization.
- Added one-step manual peripheral creation for mice, keyboards, headsets, monitors, and other equipment.
- Added optional peripheral assignment and linking to an inventory workstation.
- Added CSV template download, server-validated preview, and all-or-nothing bulk import for up to 500 peripherals.
- Added duplicate serial and asset-tag protection within imports and against existing peripheral records.
- Added manual peripheral editing and permanent deletion with audit history.
- Added 10/25/50/100-row pagination to both inventory tabs.
- CSV exports now follow the active Workstations or Peripherals tab.
- The Inventory navigation item is deselected when another MeshCentral page is opened.
- Added a peripheral-type filter for Mouse, Keyboard, Headset, Monitor, and Other.
- Fixed selected-state cleanup for MeshCentral's modern `lbbuttonsel2` navigation class.
- Isolated plugin foreground colors from MeshCentral Classic's global heading, table, form, and button rules so both dark and light Classic themes remain readable.

## 0.1.0 - 2026-10-04

- Initial asset lifecycle dashboard and per-device Inventory tab.
- Automatic hardware details sourced from MeshCentral node and sysinfo records.
- Serial/UUID matching with duplicate and identity-change warnings.
- First signed-in endpoint user automatically assigned.
- Later endpoint users queued for replace, shared-device, or dismiss review.
- Lifecycle, manual asset fields, CSV export, permissions, and audit history.
- Classic, modern, light, and dark theme integration.
- Fixed discovery for installations using MeshCentral's default empty-string domain ID.
- Review decisions now suppress only the current user-presence cycle; an absence rearms monitoring and a later return is reviewed again.
- Repeated identical agent reports no longer recreate handled user-review work.
- Linux display-manager/service accounts such as `gdm-greeter` are excluded from assignments.
- Summary cards can be clicked to filter the inventory table.
- Dashboard rows and counters refresh immediately after a review decision.
- Refreshing the browser while viewing Inventory now restores the Inventory plugin instead of an empty generic plugin page.
- Restored Inventory pages now wait for MeshCentral's WebSocket startup instead of failing with a connection-unavailable message.
- Added Online, Offline, and Not seen for 7+/30+/90+ days filters; the selected filter also applies to CSV export.
- Offline last-seen values now come from MeshCentral's authoritative `lastconnect` records instead of hardware `sysinfo` timestamps.
- Inventory navigation now appears immediately after My Devices in both classic and modern interfaces.
- The dashboard table now fills the available iframe height and uses compact, non-wrapping device rows so more assets are visible at once.
- The Inventory page heading no longer includes MeshCentral's generic "My Server Plugins -" prefix.
- UUID and serial mismatch warnings now provide audited Accept reported and Keep stored resolution actions.
- Firmware placeholders such as `OEM Chassis Serial Number` are no longer treated as unique serials, preventing unrelated devices from merging.
- Legacy multi-node assets that disagree on both serial and UUID are safely split during synchronization.
- Repeated identity-conflict audit entries are collapsed into an expandable history group.
- Initial Inventory loading retries when a startup response is lost, and opened assets are preserved in the URL across refreshes.
- Added administrator-controlled permanent deletion for retained inventory records after their MeshCentral node has been removed.
