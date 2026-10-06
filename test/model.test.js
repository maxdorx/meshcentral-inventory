'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../lib/model');

function sampleSnapshot(overrides) {
    return Object.assign({
        nodeid: 'node//device-1',
        meshid: 'mesh//group-1',
        meshName: 'DAX/MINERVA',
        name: 'DAX-LAP-042',
        osName: 'Microsoft Windows 11 Enterprise',
        agentType: 4,
        agentVersion: '1.2.5',
        publicIp: '203.0.113.10',
        serial: 'SERIAL-042',
        uuid: '2e1efb37-4707-4a5f-861f-fbb8c30dc001',
        manufacturer: 'Example Computers',
        model: 'Laptop 14',
        assetTagReported: 'TAG-042',
        cpu: 'Example CPU',
        memoryBytes: 16 * 1024 * 1024 * 1024,
        storage: [],
        pendingReboot: null,
        sysinfoTime: 1000,
        lastConnectTime: null,
        online: true,
        reportedUsers: [{ id: 'basith@example.com', display: 'basith@example.com' }]
    }, overrides || {});
}

test('normalizes serials and UUIDs while rejecting placeholders', () => {
    assert.equal(model.normalizeSerial(' ab 123 '), 'AB 123');
    assert.equal(model.normalizeSerial('To Be Filled By O.E.M.'), '');
    assert.equal(model.normalizeSerial('OEM Chassis Serial Number'), '');
    assert.equal(model.normalizeUuid('{2E1EFB37-4707-4A5F-861F-FBB8C30DC001}'), '2e1efb37-4707-4a5f-861f-fbb8c30dc001');
    assert.equal(model.normalizeUuid('00000000-0000-0000-0000-000000000000'), '');
});

test('prefers UPN signed-in users over short domain usernames', () => {
    assert.deepEqual(model.reportedUsers({
        users: ['DAX\\basith'],
        upnusers: ['basith@example.com', 'BASITH@example.com']
    }), [{ id: 'basith@example.com', display: 'basith@example.com' }]);
});

test('ignores display-manager and service accounts reported as signed-in users', () => {
    assert.equal(model.normalizeUser('gdm-greeter'), null);
    assert.equal(model.normalizeUser('HOST\\gdm-greeter'), null);
    assert.equal(model.normalizeUser('lightdm@host.local'), null);
    assert.deepEqual(model.reportedUsers({ users: ['gdm-greeter', 'DAX\\basith'] }), [
        { id: 'dax\\basith', display: 'DAX\\basith' }
    ]);
});

test('extracts an automatic snapshot from MeshCentral node and sysinfo records', () => {
    const node = {
        _id: 'node//device-1', meshid: 'mesh//group-1', name: 'DAX-LAP-042',
        osdesc: 'Windows 11', ip: '203.0.113.10', users: ['DAX\\basith'],
        upnusers: ['basith@example.com'], agent: { id: 4, ver: 125 }
    };
    const sysinfo = { time: 1234, hardware: {
        identifiers: {
            chassis_serial: ' serial-042 ', product_uuid: '{2E1EFB37-4707-4A5F-861F-FBB8C30DC001}',
            chassis_manufacturer: 'Example Computers', product_name: 'Laptop 14',
            chassis_assettag: 'TAG-042', cpu_name: 'Example CPU',
            storage_devices: [{ Caption: 'Disk 0', Model: 'SSD', Size: 512000000000 }]
        },
        windows: { memory: [{ Capacity: 8589934592 }, { Capacity: '8589934592' }] }
    } };
    const snapshot = model.snapshotFrom(node, sysinfo, 'DAX/MINERVA', true);
    assert.equal(snapshot.serial, 'SERIAL-042');
    assert.equal(snapshot.uuid, '2e1efb37-4707-4a5f-861f-fbb8c30dc001');
    assert.equal(snapshot.memoryBytes, 17179869184);
    assert.equal(snapshot.storage[0].model, 'SSD');
    assert.deepEqual(snapshot.reportedUsers, [{ id: 'basith@example.com', display: 'basith@example.com' }]);
});

test('first observed endpoint user is assigned automatically', () => {
    const now = 10000;
    const snapshot = sampleSnapshot();
    const asset = model.createAsset('inventoryasset//asset-1', '', snapshot, now);
    model.applySnapshot(asset, snapshot, now, 'agent', []);
    assert.equal(asset.status, 'Assigned');
    assert.equal(asset.assignment.mode, 'single');
    assert.deepEqual(asset.assignment.assignees.map((item) => item.id), ['basith@example.com']);
    assert.equal(asset.assignment.pending.length, 0);
});

test('a later signed-in user is flagged exactly once for administrator review', () => {
    const first = sampleSnapshot();
    const asset = model.createAsset('inventoryasset//asset-1', '', first, 10000);
    model.applySnapshot(asset, first, 10000, 'agent', []);

    const second = sampleSnapshot({ reportedUsers: [{ id: 'sjalani@example.com', display: 'sjalani@example.com' }] });
    model.applySnapshot(asset, second, 20000, 'agent', []);
    model.applySnapshot(asset, second, 30000, 'agent', []);
    assert.equal(asset.assignment.pending.length, 1);
    assert.equal(asset.assignment.pending[0].id, 'sjalani@example.com');
    assert.equal(asset.assignment.pending[0].lastSeen, 30000);
});

test('administrator can replace, share, dismiss, and clear assignments', () => {
    const first = sampleSnapshot();
    const asset = model.createAsset('inventoryasset//asset-1', '', first, 10000);
    model.applySnapshot(asset, first, 10000, 'agent', []);
    const candidate = { id: 'sjalani@example.com', display: 'sjalani@example.com' };
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [candidate] }), 20000, 'agent', []);

    model.assignmentAction(asset, 'share', candidate, 'user//admin@example.com', 21000);
    assert.equal(asset.assignment.mode, 'shared');
    assert.deepEqual(asset.assignment.assignees.map((item) => item.id), ['basith@example.com', 'sjalani@example.com']);

    const replacement = { id: 'zimran@example.com', display: 'zimran@example.com' };
    model.assignmentAction(asset, 'replace', replacement, 'user//admin@example.com', 22000);
    assert.deepEqual(asset.assignment.assignees.map((item) => item.id), ['zimran@example.com']);

    const dismissed = { id: 'visitor@example.com', display: 'visitor@example.com' };
    asset.assignment.pending.push(dismissed);
    model.assignmentAction(asset, 'dismiss', dismissed, 'user//admin@example.com', 23000);
    assert.ok(asset.assignment.resolutions.some((item) => item.id === 'visitor@example.com' && item.decision === 'dismissed'));

    model.assignmentAction(asset, 'unassign', {}, 'user//admin@example.com', 24000);
    assert.equal(asset.assignment.mode, 'unassigned');
    assert.equal(asset.status, 'Available');
});

test('dismissal suppresses the current presence cycle but alerts after absence and return', () => {
    const user1 = { id: 'user1@example.com', display: 'user1@example.com' };
    const user2 = { id: 'user2@example.com', display: 'user2@example.com' };
    const user3 = { id: 'user3@example.com', display: 'user3@example.com' };
    const asset = model.createAsset('inventoryasset//asset-1', '', sampleSnapshot(), 10000);

    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 10000, 'agent', []);
    assert.deepEqual(asset.assignment.assignees.map((item) => item.id), ['user1@example.com']);
    assert.deepEqual(asset.assignment.pending.map((item) => item.id), ['user2@example.com']);

    model.assignmentAction(asset, 'dismiss', user2, 'user//admin@example.com', 11000);
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 12000, 'agent', []);
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 13000, 'agent', []);
    assert.deepEqual(asset.assignment.pending, []);
    assert.equal(asset.history.filter((item) => item.action === 'assignment.review' && item.details.includes('user2')).length, 1);

    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1] }), 14000, 'agent', []);
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1] }), 15000, 'agent', []);
    assert.equal(asset.assignment.resolutions.find((item) => item.id === user2.id).armed, true);
    assert.equal(asset.history.filter((item) => item.action === 'assignment.absent' && item.details.includes('user2')).length, 1);

    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user3] }), 16000, 'agent', []);
    assert.deepEqual(asset.assignment.pending.map((item) => item.id), ['user3@example.com']);

    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2, user3] }), 17000, 'agent', []);
    assert.deepEqual(asset.assignment.pending.map((item) => item.id).sort(), ['user2@example.com', 'user3@example.com']);
    assert.equal(asset.history.filter((item) => item.action === 'assignment.returned' && item.details.includes('user2')).length, 1);

    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2, user3] }), 18000, 'agent', []);
    assert.equal(asset.assignment.pending.filter((item) => item.id === user2.id).length, 1);
    assert.equal(asset.history.filter((item) => item.action === 'assignment.returned' && item.details.includes('user2')).length, 1);
});

test('offline or non-authoritative scans do not rearm dismissed-user monitoring', () => {
    const user1 = { id: 'user1@example.com', display: 'user1@example.com' };
    const user2 = { id: 'user2@example.com', display: 'user2@example.com' };
    const asset = model.createAsset('inventoryasset//asset-1', '', sampleSnapshot(), 10000);
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 10000, 'agent', []);
    model.assignmentAction(asset, 'dismiss', user2, 'user//admin@example.com', 11000);

    model.applySnapshot(asset, sampleSnapshot({
        online: false, reportedUsers: [user1], userReportAuthoritative: false
    }), 12000, 'synchronizer', []);
    assert.equal(asset.assignment.resolutions.find((item) => item.id === user2.id).armed, false);

    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 13000, 'agent', []);
    assert.deepEqual(asset.assignment.pending, []);
});

test('replacing an assignee does not immediately requeue the displaced present user', () => {
    const user1 = { id: 'user1@example.com', display: 'user1@example.com' };
    const user2 = { id: 'user2@example.com', display: 'user2@example.com' };
    const asset = model.createAsset('inventoryasset//asset-1', '', sampleSnapshot(), 10000);
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 10000, 'agent', []);
    model.assignmentAction(asset, 'replace', user2, 'user//admin@example.com', 11000);
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [user1, user2] }), 12000, 'agent', []);
    assert.deepEqual(asset.assignment.assignees.map((item) => item.id), ['user2@example.com']);
    assert.deepEqual(asset.assignment.pending, []);
    assert.equal(asset.assignment.resolutions.find((item) => item.id === user1.id).armed, false);
});

test('manual assignment survives an empty agent report and flags a different reported user once', () => {
    const snapshot = sampleSnapshot({ reportedUsers: [] });
    const asset = model.createAsset('inventoryasset//mac', '', snapshot, 1000);
    model.applySnapshot(asset, snapshot, 1000, 'agent', []);
    model.assignmentAction(asset, 'manual-replace', { display: 'Owner@example.com' }, 'user//admin', 2000);
    assert.equal(asset.status, 'Assigned');
    assert.equal(asset.assignment.assignees[0].source, 'manual');
    model.applySnapshot(asset, snapshot, 3000, 'agent', []);
    assert.equal(asset.assignment.assignees[0].id, 'owner@example.com');
    model.applySnapshot(asset, sampleSnapshot({ reportedUsers: [{ id: 'owner@example.com', display: 'owner@example.com' }] }), 4000, 'agent', []);
    assert.deepEqual(asset.assignment.pending, []);
    const other = sampleSnapshot({ reportedUsers: [{ id: 'other@example.com', display: 'other@example.com' }] });
    model.applySnapshot(asset, other, 5000, 'agent', []);
    model.applySnapshot(asset, other, 6000, 'agent', []);
    assert.deepEqual(asset.assignment.assignees.map((item) => item.id), ['owner@example.com']);
    assert.deepEqual(asset.assignment.pending.map((item) => item.id), ['other@example.com']);
    assert.equal(asset.history.filter((item) => item.action === 'assignment.manual').length, 1);
});

test('stale policy follows removal days and validates custom thresholds', () => {
    assert.deepEqual(model.stalePolicy({ mode: 'meshcentral' }, 14), { enabled: true, days: 13, removalDays: 14, warning: false });
    assert.equal(model.stalePolicy({ mode: 'meshcentral' }, null).days, 30);
    assert.equal(model.stalePolicy({ mode: 'custom', days: 14 }, 14).warning, true);
    assert.equal(model.stalePolicy({ mode: 'disabled' }, 14).enabled, false);
    assert.throws(() => model.stalePolicy({ mode: 'custom', days: 0 }, 14), /threshold/);
});

test('stale and missing reviews are idempotent, and reconnect rearms the next offline cycle', () => {
    const day = 86400000;
    const asset = model.createAsset('inventoryasset//presence', '', sampleSnapshot(), day);
    model.applySnapshot(asset, sampleSnapshot(), day, 'agent', []);
    model.applySnapshot(asset, sampleSnapshot({ online: false, userReportAuthoritative: false }), day * 5, 'synchronizer', []);
    const policy = model.stalePolicy({ mode: 'custom', days: 3 }, null);
    model.evaluateReviews(asset, policy, day * 5);
    model.evaluateReviews(asset, policy, day * 6);
    assert.equal(asset.status, 'Assigned');
    assert.deepEqual(asset.reviews.map((item) => item.reason), ['stale-device']);
    assert.equal(asset.history.filter((item) => item.action === 'review.stale-device').length, 1);
    model.reviewAction(asset, 'acknowledge', 'stale-device', '', 'user//admin', day * 6);
    model.evaluateReviews(asset, policy, day * 6);
    assert.deepEqual(asset.reviews, []);
    asset.automatic.nodeExists = false;
    model.evaluateReviews(asset, policy, day * 6);
    assert.deepEqual(asset.reviews.map((item) => item.reason), ['node-missing']);
    assert.equal(asset.status, 'Assigned');
    model.reviewAction(asset, 'acknowledge', 'node-missing', '', 'user//admin', day * 6);
    model.evaluateReviews(asset, policy, day * 7);
    assert.deepEqual(asset.reviews, []);
    assert.equal(asset.automatic.condition, 'Node missing');
    model.applySnapshot(asset, sampleSnapshot(), day * 8, 'agent', []);
    model.evaluateReviews(asset, policy, day * 8);
    assert.equal(asset.presence.acknowledgedReason, undefined);
    model.applySnapshot(asset, sampleSnapshot({ online: false, userReportAuthoritative: false }), day * 12, 'synchronizer', []);
    model.evaluateReviews(asset, policy, day * 12);
    assert.deepEqual(asset.reviews.map((item) => item.reason), ['stale-device']);
    assert.equal(asset.automatic.condition, 'Stale');
});

test('archived records stay archived when their agent returns and require restoration', () => {
    const day = 86400000;
    const asset = model.createAsset('inventoryasset//archived', '', sampleSnapshot(), day);
    model.applySnapshot(asset, sampleSnapshot(), day, 'agent', []);
    asset.automatic.nodeExists = false;
    asset.automatic.online = false;
    model.evaluateReviews(asset, model.stalePolicy({ mode: 'meshcentral' }, null), day * 2);
    model.reviewAction(asset, 'archive', 'node-missing', '', 'user//admin', day * 2);
    assert.equal(asset.recordState, 'Archived');
    assert.equal(asset.status, 'Assigned');
    model.applySnapshot(asset, sampleSnapshot(), day * 3, 'agent', []);
    model.evaluateReviews(asset, model.stalePolicy({ mode: 'meshcentral' }, null), day * 3);
    model.evaluateReviews(asset, model.stalePolicy({ mode: 'meshcentral' }, null), day * 4);
    assert.equal(asset.recordState, 'Archived');
    assert.equal(asset.history.filter((item) => item.action === 'review.archived-returned').length, 1);
    model.reviewAction(asset, 'restore', '', '', 'user//admin', day * 4);
    assert.equal(asset.recordState, 'Active');
    assert.deepEqual(asset.reviews, []);
});

test('assigned without an assignee is reviewed once until manual assignment resolves it', () => {
    const asset = model.createAsset('inventoryasset//unassigned', '', sampleSnapshot({ reportedUsers: [] }), 1000);
    asset.status = 'Assigned';
    model.evaluateReviews(asset, null, 2000);
    model.evaluateReviews(asset, null, 3000);
    assert.deepEqual(asset.reviews.map((item) => item.reason), ['assignment-missing']);
    assert.equal(asset.history.filter((item) => item.action === 'review.assignment-missing').length, 1);
    model.assignmentAction(asset, 'manual-replace', { display: 'owner@example.com' }, 'user//admin', 4000);
    assert.deepEqual(asset.reviews, []);
});

test('prefers UUID identity and does not merge a reused serial with a different UUID', () => {
    const bySerial = { _id: 'a', identity: { serial: 'SERIAL-042', uuid: 'uuid-a' }, createdAt: 1 };
    const byUuid = { _id: 'b', identity: { serial: 'SERIAL-B', uuid: '2e1efb37-4707-4a5f-861f-fbb8c30dc001' }, createdAt: 2 };
    const selected = model.selectAsset([bySerial, byUuid], sampleSnapshot());
    assert.equal(selected.asset._id, 'b');
    assert.ok(selected.conflicts.some((item) => item.kind === 'serial-mismatch'));
    assert.equal(selected.conflicts.some((item) => item.kind === 'duplicate-match'), false);
});

test('reports duplicates when multiple records share the same UUID', () => {
    const identity = { serial: 'SERIAL-042', uuid: '2e1efb37-4707-4a5f-861f-fbb8c30dc001' };
    const selected = model.selectAsset([
        { _id: 'a', identity: identity, createdAt: 1 },
        { _id: 'b', identity: identity, createdAt: 2 }
    ], sampleSnapshot());
    assert.equal(selected.asset._id, 'a');
    assert.ok(selected.conflicts.some((item) => item.kind === 'duplicate-match'));
});

test('flags changed hardware identity on an already linked node', () => {
    const original = sampleSnapshot();
    const asset = model.createAsset('inventoryasset//asset-1', '', original, 10000);
    model.applySnapshot(asset, original, 10000, 'agent', []);
    const changed = sampleSnapshot({ serial: 'SERIAL-NEW', uuid: 'c0b4cf68-2e98-4ab5-8865-c45054293932' });
    model.applySnapshot(asset, changed, 20000, 'agent', []);
    assert.equal(asset.identity.serial, 'SERIAL-042');
    assert.equal(asset.identity.uuid, '2e1efb37-4707-4a5f-861f-fbb8c30dc001');
    assert.deepEqual(asset.identityConflicts.map((item) => item.kind).sort(), ['serial-mismatch', 'uuid-mismatch']);
});

test('administrator can accept a reported identity change with audit history', () => {
    const asset = model.createAsset('inventoryasset//asset-1', '', sampleSnapshot(), 10000);
    model.applySnapshot(asset, sampleSnapshot(), 10000, 'agent', []);
    const changed = sampleSnapshot({ uuid: 'c0b4cf68-2e98-4ab5-8865-c45054293932' });
    model.applySnapshot(asset, changed, 20000, 'agent', []);
    const conflict = asset.identityConflicts.find((item) => item.kind === 'uuid-mismatch');
    model.identityConflictAction(asset, 'accept', conflict, 'user//admin', 21000);
    assert.equal(asset.identity.uuid, changed.uuid);
    assert.equal(asset.identityConflicts.length, 0);
    assert.ok(asset.history.some((item) => item.action === 'identity.accepted'));
    model.applySnapshot(asset, changed, 22000, 'agent', []);
    assert.equal(asset.identityConflicts.length, 0);
});

test('keeping stored identity suppresses only the exact reported mismatch', () => {
    const asset = model.createAsset('inventoryasset//asset-1', '', sampleSnapshot(), 10000);
    model.applySnapshot(asset, sampleSnapshot(), 10000, 'agent', []);
    const firstChange = sampleSnapshot({ uuid: 'c0b4cf68-2e98-4ab5-8865-c45054293932' });
    model.applySnapshot(asset, firstChange, 20000, 'agent', []);
    model.identityConflictAction(asset, 'keep', asset.identityConflicts[0], 'user//admin', 21000);
    model.applySnapshot(asset, firstChange, 22000, 'agent', []);
    assert.equal(asset.identityConflicts.length, 0);
    const secondChange = sampleSnapshot({ uuid: '78d6a908-2e69-4fcf-a61c-bdfba4b12511' });
    model.applySnapshot(asset, secondChange, 23000, 'agent', []);
    assert.equal(asset.identityConflicts.length, 1);
    assert.equal(asset.identityConflicts[0].observed, secondChange.uuid);
    assert.ok(asset.history.some((item) => item.action === 'identity.kept'));
});

test('offline refresh keeps the previous last-seen timestamp', () => {
    const online = sampleSnapshot({ online: true });
    const asset = model.createAsset('inventoryasset//asset-1', '', online, 10000);
    model.applySnapshot(asset, online, 10000, 'agent', []);
    model.applySnapshot(asset, sampleSnapshot({ online: false }), 20000, 'synchronizer', []);
    assert.equal(asset.automatic.lastSeen, 10000);
});

test('MeshCentral last-connect record corrects an offline asset last-seen timestamp', () => {
    const online = sampleSnapshot({ online: true });
    const asset = model.createAsset('inventoryasset//asset-1', '', online, 10000);
    model.applySnapshot(asset, online, 10000, 'agent', []);
    model.applySnapshot(asset, sampleSnapshot({
        online: false,
        sysinfoTime: 19000,
        lastConnectTime: 15000
    }), 20000, 'synchronizer', []);
    assert.equal(asset.automatic.lastSeen, 15000);
    assert.equal(asset.automatic.lastConnectTime, 15000);
});

test('normalizes and validates manual peripheral input', () => {
    const parsed = model.peripheralInput({
        type: 'headphones', manufacturer: 'Example', model: 'USB Pro', serial: ' hp-001 ',
        assigned_user: 'Person@example.com', linked_workstation: 'DAX-LAP-001',
        purchase_date: '04/10/2026', warranty_end: '2028-10-04'
    });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.value.peripheralType, 'Headset');
    assert.equal(parsed.value.name, 'Example USB Pro');
    assert.equal(parsed.value.serial, 'HP-001');
    assert.equal(parsed.value.status, 'Assigned');
    assert.equal(parsed.value.purchaseDate, '2026-10-04');
    assert.equal(parsed.value.warrantyEnd, '2028-10-04');

    const invalid = model.peripheralInput({ type: 'printer', serial: 'To Be Filled By O.E.M.', status: 'Assigned' });
    assert.ok(invalid.errors.some((error) => error.includes('Type must be')));
    assert.ok(invalid.errors.some((error) => error.includes('placeholder')));
    assert.ok(invalid.errors.some((error) => error.includes('Assigned user')));
});

test('creates a manual peripheral without an agent and with an optional workstation link', () => {
    const linked = { _id: 'inventoryasset//workstation-1', nodeid: 'node//device-1', name: 'DAX-LAP-001' };
    const asset = model.createPeripheral('inventoryasset//peripheral-1', '', {
        type: 'monitor', name: 'Front desk monitor', asset_tag: 'MON-001', serial: 'lcd-001',
        manufacturer: 'Dell', model: 'P2422H', assigned_user: 'user@example.com', status: 'Assigned'
    }, 'user//admin', 10000, linked);
    assert.equal(asset.assetKind, 'peripheral');
    assert.equal(asset.source, 'manual');
    assert.equal(asset.peripheral.type, 'Monitor');
    assert.equal(asset.identity.serial, 'LCD-001');
    assert.equal(asset.nodeid, '');
    assert.deepEqual(asset.nodeids, []);
    assert.equal(Object.hasOwn(asset, 'meshid'), false);
    assert.equal(asset.links.workstationAssetId, linked._id);
    assert.equal(asset.assignment.assignees[0].id, 'user@example.com');
    assert.ok(asset.history.some((entry) => entry.action === 'peripheral.created'));
});

test('normalizes and validates manual workstation input', () => {
    const parsed = model.workstationInput({
        name: ' Reception PC ', serial: ' pc-001 ', uuid: '{A0B1C2D3-E4F5-4678-9123-1234567890AB}',
        assigned_user: 'reception@example.com', purchase_date: '04/10/2026'
    });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.value.name, 'Reception PC');
    assert.equal(parsed.value.serial, 'PC-001');
    assert.equal(parsed.value.uuid, 'a0b1c2d3-e4f5-4678-9123-1234567890ab');
    assert.equal(parsed.value.status, 'Assigned');
    assert.equal(parsed.value.purchaseDate, '2026-10-04');

    const invalid = model.workstationInput({ name: '', serial: 'To Be Filled By O.E.M.', status: 'Assigned' });
    assert.ok(invalid.errors.some((error) => error.includes('name is required')));
    assert.ok(invalid.errors.some((error) => error.includes('placeholder')));
    assert.ok(invalid.errors.some((error) => error.includes('Assigned user')));
});

test('creates a separate manual workstation with no MeshCentral agent link', () => {
    const asset = model.createManualWorkstation('inventoryasset//manual-pc-1', '', {
        name: 'Reception PC', serial: 'pc-001', uuid: 'a0b1c2d3-e4f5-4678-9123-1234567890ab',
        manufacturer: 'Dell', model: 'OptiPlex', os_name: 'Windows 11', asset_tag: 'WS-001',
        assigned_user: 'reception@example.com', status: 'Assigned'
    }, 'user//admin', 10000);
    assert.equal(asset.assetKind, 'workstation');
    assert.equal(asset.source, 'manual');
    assert.equal(asset.nodeid, '');
    assert.deepEqual(asset.nodeids, []);
    assert.equal(Object.hasOwn(asset, 'meshid'), false);
    assert.equal(asset.automatic.nodeExists, false);
    assert.equal(asset.manualHardware.model, 'OptiPlex');
    assert.equal(asset.assignment.assignees[0].id, 'reception@example.com');
    assert.ok(asset.history.some((entry) => entry.action === 'workstation.created'));
});
