# Design decisions

## Scope

The source of truth for automatic data is MeshCentral itself. The plugin reads `node` and `sysinfo` records and listens to MeshAgent hooks; it does not deploy another collector. Installed software and Registry are owned by MeshCentral's built-in online views.

## Asset record

Each `inventoryasset` record contains:

- immutable/cautious identity: normalized serial and UUID;
- every linked MeshCentral node ID;
- latest automatic snapshot;
- manual lifecycle fields;
- assignment state and observed endpoint users;
- identity conflicts;
- bounded audit history.

Manual workstations use `source: "manual"`, contain no MeshCentral mesh ID, and never participate in automatic agent identity matching. Serial, UUID, and asset-tag duplicates are rejected when an administrator creates or changes a manual workstation. If an agent later reports matching hardware, the automatic record remains separate and both records receive a cross-source duplicate warning.

The document ID is a SHA-256-derived stable ID based on domain plus UUID, serial, or node ID. The readable serial and UUID remain ordinary fields for matching and display.

## Duplicate prevention

The sync transaction is serialized per MeshCentral domain. It checks existing node links first, then serial/UUID matches, then creates only if neither exists. This provides in-process atomicity without relying on a MongoDB-only unique index, keeping the plugin compatible with MeshCentral's supported databases.

If two pre-existing records independently match different identifiers from one device, the UUID match is selected and a duplicate-match warning is recorded. The plugin never silently merges conflicting historical assets.

## Endpoint-user handling

`upnusers` is preferred because it normally supplies a stable e-mail/UPN. If absent, `users` is accepted. IDs are compared case-insensitively while preserving the latest display spelling.

Assignment is intentionally a reviewed asset-management decision after the first observation. An account appearing at the Windows sign-in screen or during support work must not silently take ownership from an existing assignee.

A dismissal/replacement acknowledges one continuous presence cycle rather than permanently ignoring the user. Repeated reports remain quiet while that user is still present. An authoritative agent report showing the user absent rearms monitoring; a later return creates one new review. Offline/stale database scans cannot rearm monitoring. These transitions and their timestamps are retained in the audit history.

Full administrators can maintain a domain-wide ignored-account list in Inventory settings. Exact IDs are case-insensitive. Bare usernames match the local name in `DOMAIN\user` and `user@domain` reports; qualified entries match only the full ID. Ignored users are filtered before automatic assignment and review, and newly saved rules clear matching pending observations and agent-derived assignees. Manual assignees remain deliberate inventory decisions. Removing a rule permits the next authoritative agent report to create a new observation.

## Retention

MeshCentral may remove inactive nodes after the configured retention window. The asset is marked offline/missing but remains in inventory, preserving lifecycle, assignment, financial dates, notes, and history.

## Security

- Server-side permission checks protect every read/write action; hidden UI controls are only a convenience.
- Asset visibility is limited to the user's domain and accessible MeshCentral device groups.
- Browser output is built with DOM `textContent`, not untrusted `innerHTML`.
- Embedded boot JSON escapes `<`, `>`, and `&`.
- Manual fields are length-limited on the server.
- The plugin has no external runtime dependencies or outbound requests.
