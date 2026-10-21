'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');

test('server plugin loads and registers the expected permissions', () => {
    let registered = null;
    const database = {
        Get() {}, Set() {}, Remove() {}, GetAllTypeNoTypeField() {}
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions(name, permissions) { registered = { name, permissions }; },
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    assert.equal(registered.name, 'inventory');
    assert.deepEqual(Object.keys(registered.permissions), ['can_view', 'can_manage', 'can_sync']);
    assert.equal(typeof plugin.serveraction, 'function');
    assert.equal(typeof plugin.handleAdminReq, 'function');
    assert.ok(plugin.exports.includes('onDeviceRefreshEnd'));
    assert.ok(plugin.exports.includes('goPageStart'));
    assert.ok(plugin.exports.includes('setInventoryUrlMarker'));
    assert.ok(plugin.exports.includes('setInventoryHeading'));
    assert.ok(plugin.exports.includes('setInventorySelected'));
    assert.ok(plugin.exports.includes('setInventoryHostChrome'));
    assert.ok(plugin.exports.includes('inventoryBack'));
    assert.ok(plugin.exports.includes('enforceModernUI'));
    assert.ok(plugin.exports.includes('trackPluginFrame'));
});

test('manual deletion is allowed only after the MeshCentral node is confirmed missing', async () => {
    const assetId = 'inventoryasset//missing-node-asset';
    let removed = null;
    let asset = {
        _id: assetId, type: 'inventoryasset', domain: '', nodeid: 'node//deleted-device',
        meshid: 'mesh//group-1', automatic: { nodeExists: false }
    };
    const database = {
        Get(id, callback) { callback(null, id === assetId ? [asset] : []); },
        Set() {},
        Remove(id, callback) { removed = id; callback(null); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, []); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' },
        user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const invoke = (command) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction(Object.assign({ requestId: 'delete-test' }, command), session);
    });

    let response = await invoke({ pluginaction: 'delete', assetId, confirm: true });
    assert.equal(response.ok, true);
    assert.equal(response.result.kind, 'deleted');
    assert.equal(removed, assetId);

    removed = null;
    asset = Object.assign({}, asset, { automatic: { nodeExists: true } });
    response = await invoke({ pluginaction: 'delete', assetId, confirm: true });
    assert.equal(response.ok, false);
    assert.match(response.error, /only be deleted after/i);
    assert.equal(removed, null);
});

test('opening a retained workstation without a mesh never asks MeshCentral to resolve its missing node', async () => {
    const assetId = 'inventoryasset//retained-node-asset';
    const asset = {
        _id: assetId, type: 'inventoryasset', domain: '', source: 'automatic',
        nodeid: 'node//no-longer-present', name: 'RETAINED-PC',
        automatic: { nodeExists: false }, assignment: { assignees: [], pending: [] }
    };
    const permissionContexts = [];
    const database = {
        Get(id, callback) { callback(null, id === assetId ? [asset] : []); },
        Set() {}, Remove() {}, GetAllTypeNoTypeField(type, domain, callback) { callback(null, []); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions(name, user, context) {
            permissionContexts.push(context);
            if (context && context.nodeid && !context.meshid) throw new Error('unsafe missing-node lookup');
            return Promise.resolve(() => true);
        }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'retained-get', pluginaction: 'get', assetId }, session);
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.asset.name, 'RETAINED-PC');
    assert.deepEqual(permissionContexts, [{}]);
});

test('agent synchronization accepts nodes in MeshCentral default domain', async () => {
    let savedAsset;
    let finish;
    const saved = new Promise((resolve) => { finish = resolve; });
    const node = {
        _id: 'node//device-1', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-042',
        osdesc: 'Windows 11', users: ['EXAMPLE\\serviceaccount', 'EXAMPLE\\operator'], agent: { id: 4, ver: 125 }
    };
    const sysinfo = {
        _id: 'sinode//device-1', domain: '', type: 'sysinfo', time: Date.now(),
        hardware: { identifiers: { chassis_serial: 'SERIAL-042', product_uuid: '2e1efb37-4707-4a5f-861f-fbb8c30dc001' } }
    };
    const database = {
        Get(id, callback) {
            if (id === node._id) return callback(null, [node]);
            if (id === `si${node._id}`) return callback(null, [sysinfo]);
            if (id === 'inventorysettings/') return callback(null, [{ _id: id, type: 'inventorysettings', mode: 'meshcentral', days: 30, ignoredUsers: ['serviceaccount'] }]);
            callback(null, []);
        },
        GetAllTypeNoTypeField(type, domain, callback) {
            assert.equal(domain, '');
            if (type === 'inventoryasset') return callback(null, []);
            callback(null, []);
        },
        Set(document, callback) {
            savedAsset = document;
            callback(null);
            finish();
        }
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { meshes: { 'mesh//group-1': { name: 'Example Fleet' } }, wsagents: {} },
            config: { domains: { '': {} } }
        },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    plugin.hook_agentCoreIsStable({ dbNodeKey: node._id });
    await Promise.race([
        saved,
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('sync timed out')), 1000))
    ]);
    assert.equal(savedAsset.domain, '');
    assert.equal(savedAsset.type, 'inventoryasset');
    assert.equal(savedAsset.name, 'DEMO-LAP-042');
    assert.deepEqual(savedAsset.assignment.assignees.map((user) => user.id), ['example\\operator']);
    assert.deepEqual(savedAsset.assignment.pending, []);
});

test('synchronization splits a node from a legacy placeholder-serial merge', async () => {
    const nodeId = 'node//device-b';
    const oldNodeId = 'node//device-a';
    const legacyAsset = {
        _id: 'inventoryasset//legacy', type: 'inventoryasset', domain: '',
        nodeid: oldNodeId, nodeids: [oldNodeId, nodeId], meshid: 'mesh//group-1', name: 'DEVICE-A',
        identity: { serial: 'OEM CHASSIS SERIAL NUMBER', uuid: '9805dbee-769e-744d-9e98-07300c922190' },
        automatic: {}, manual: {}, assignment: { assignees: [], pending: [], resolutions: [] }, history: []
    };
    const node = {
        _id: nodeId, domain: '', meshid: 'mesh//group-1', name: 'DEVICE-B',
        users: [], agent: { id: 4, ver: 125 }
    };
    const sysinfo = {
        _id: `si${nodeId}`, time: 1234,
        hardware: { identifiers: {
            chassis_serial: 'OEM Chassis Serial Number', bios_serial: 'BIOS-B',
            product_uuid: '081e37bf-d691-774b-86ce-a80af333132d'
        } }
    };
    const saved = [];
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const database = {
        Get(id, callback) {
            if (id === nodeId) return callback(null, [node]);
            if (id === `si${nodeId}`) return callback(null, [sysinfo]);
            callback(null, []);
        },
        GetAllTypeNoTypeField(type, domain, callback) {
            callback(null, type === 'inventoryasset' ? [legacyAsset] : []);
        },
        Set(document, callback) {
            saved.push(JSON.parse(JSON.stringify(document)));
            callback(null);
            if (document._id !== legacyAsset._id) finish();
        }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    plugin.hook_agentCoreIsStable({ dbNodeKey: nodeId });
    await Promise.race([completed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('split timed out')), 1000))]);
    const repairedLegacy = saved.find((item) => item._id === legacyAsset._id);
    const newAsset = saved.find((item) => item._id !== legacyAsset._id);
    assert.deepEqual(repairedLegacy.nodeids, [oldNodeId]);
    assert.deepEqual(repairedLegacy.assignment.pending, []);
    assert.ok(repairedLegacy.history.some((item) => item.action === 'identity.merge-repaired'));
    assert.equal(newAsset.nodeid, nodeId);
    assert.equal(newAsset.identity.serial, 'BIOS-B');
    assert.equal(newAsset.identity.uuid, '081e37bf-d691-774b-86ce-a80af333132d');
});

test('legacy split never overwrites an existing asset whose id came from the reported UUID', async () => {
    const nodeId = 'node//device-b';
    const oldNodeId = 'node//device-a';
    const reportedUuid = '081e37bf-d691-774b-86ce-a80af333132d';
    const legacyIdHash = crypto.createHash('sha256').update(`\n${reportedUuid}`).digest('hex').substring(0, 32);
    const legacyAsset = {
        _id: `inventoryasset//${legacyIdHash}`, type: 'inventoryasset', domain: '',
        nodeid: oldNodeId, nodeids: [oldNodeId, nodeId], meshid: 'mesh//group-1', name: 'DEVICE-A',
        identity: { serial: 'OEM CHASSIS SERIAL NUMBER', uuid: '9805dbee-769e-744d-9e98-07300c922190' },
        automatic: {}, manual: {}, assignment: { assignees: [], pending: [], resolutions: [] }, history: []
    };
    const node = {
        _id: nodeId, domain: '', meshid: 'mesh//group-1', name: 'DEVICE-B',
        users: [], agent: { id: 4, ver: 125 }
    };
    const sysinfo = {
        _id: `si${nodeId}`, time: 1234,
        hardware: { identifiers: {
            chassis_serial: 'OEM Chassis Serial Number', bios_serial: 'BIOS-B', product_uuid: reportedUuid
        } }
    };
    const saved = [];
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const database = {
        Get(id, callback) {
            if (id === nodeId) return callback(null, [node]);
            if (id === `si${nodeId}`) return callback(null, [sysinfo]);
            callback(null, []);
        },
        GetAllTypeNoTypeField(type, domain, callback) {
            callback(null, type === 'inventoryasset' ? [legacyAsset] : []);
        },
        Set(document, callback) {
            saved.push(JSON.parse(JSON.stringify(document)));
            callback(null);
            if (saved.length === 2) finish();
        }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    plugin.hook_agentCoreIsStable({ dbNodeKey: nodeId });
    await Promise.race([completed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('collision-safe split timed out')), 1000))]);

    const repairedLegacy = saved.find((item) => item._id === legacyAsset._id);
    const newAsset = saved.find((item) => item._id !== legacyAsset._id);
    assert.ok(repairedLegacy, 'the original asset must still be saved under its original id');
    assert.ok(newAsset, 'the split hardware must receive a different id');
    assert.deepEqual(repairedLegacy.nodeids, [oldNodeId]);
    assert.equal(newAsset.identity.uuid, reportedUuid);
    assert.notEqual(newAsset._id, legacyAsset._id);
});

test('manual peripherals support creation, CSV preview validation, workstation links, and deletion', async () => {
    const workstation = {
        _id: 'inventoryasset//workstation-1', type: 'inventoryasset', domain: '', nodeid: 'node//device-1',
        nodeids: ['node//device-1'], meshid: 'mesh//group-1', name: 'DEMO-LAP-001',
        identity: { serial: 'PC-001', uuid: '11111111-1111-4111-8111-111111111111' },
        automatic: { nodeExists: true }, manual: { assetTag: 'PC-TAG-001' },
        assignment: { mode: 'unassigned', assignees: [], pending: [] }
    };
    const records = new Map([[workstation._id, workstation]]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, Array.from(records.values()).filter((record) => record.type === type)); },
        Set(document, callback) { records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    let requestId = 0;
    const invoke = (command) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction(Object.assign({ requestId: `peripheral-test-${++requestId}` }, command), session);
    });

    const createdResponse = await invoke({ pluginaction: 'peripheral-create', peripheral: {
        type: 'mouse', name: 'Reception mouse', serial: 'MOUSE-001', asset_tag: 'PER-001',
        assigned_user: 'reception@example.com', linked_workstation: 'DEMO-LAP-001', status: 'Assigned'
    } });
    assert.equal(createdResponse.ok, true);
    const created = createdResponse.result.assets[0];
    assert.equal(created.assetKind, 'peripheral');
    assert.equal(created.links.workstationAssetId, workstation._id);
    assert.equal(created.assignment.assignees[0].id, 'reception@example.com');
    const backupId = created.id.replace('inventoryasset/', 'inventoryassetbackup/');
    assert.equal(records.get(backupId).assetId, created.id);
    assert.equal(records.get(backupId).asset.assetKind, 'peripheral');

    const preview = await invoke({ pluginaction: 'peripheral-preview', rows: [
        { rowNumber: 2, type: 'Keyboard', serial: 'KEY-001', asset_tag: 'PER-002', linked_workstation: 'PC-001' },
        { rowNumber: 3, type: 'Monitor', serial: 'KEY-001', asset_tag: 'PER-002' },
        { rowNumber: 4, type: 'Printer', linked_workstation: 'DOES-NOT-EXIST' }
    ] });
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.result.rows[0].errors, []);
    assert.ok(preview.result.rows[1].errors.some((error) => error.includes('Serial number already')));
    assert.ok(preview.result.rows[1].errors.some((error) => error.includes('Asset tag already')));
    assert.ok(preview.result.rows[2].errors.some((error) => error.includes('Type must be')));
    assert.ok(preview.result.rows[2].errors.some((error) => error.includes('was not found')));

    const deleted = await invoke({ pluginaction: 'delete', assetId: created.id, confirm: true });
    assert.equal(deleted.ok, true);
    assert.equal(records.has(created.id), false);
    assert.equal(records.has(backupId), false);
    const rescanned = await invoke({ pluginaction: 'rescan' });
    assert.equal(rescanned.ok, true);
    assert.equal(records.has(created.id), false, 'confirmed deletion must not be restored');
});

test('agent synchronization never merges a workstation into a manual peripheral with the same serial', async () => {
    const node = { _id: 'node//device-2', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-002', users: [], agent: { id: 4, ver: 125 } };
    const sysinfo = {
        _id: `si${node._id}`, time: 1000,
        hardware: { identifiers: { chassis_serial: 'SHARED-SERIAL', product_uuid: '22222222-2222-4222-8222-222222222222' } }
    };
    const peripheral = {
        _id: 'inventoryasset//peripheral-1', type: 'inventoryasset', domain: '', assetKind: 'peripheral', source: 'manual',
        name: 'Tagged mouse', identity: { serial: 'SHARED-SERIAL', uuid: '' }, nodeid: '', nodeids: [],
        peripheral: { type: 'Mouse' }, automatic: {}, manual: {},
        assignment: { mode: 'unassigned', assignees: [], pending: [] }, history: []
    };
    const records = new Map([[peripheral._id, peripheral]]);
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const database = {
        Get(id, callback) {
            if (id === node._id) return callback(null, [node]);
            if (id === `si${node._id}`) return callback(null, [sysinfo]);
            callback(null, records.has(id) ? [records.get(id)] : []);
        },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, Array.from(records.values()).filter((record) => record.type === type)); },
        Set(document, callback) {
            records.set(document._id, JSON.parse(JSON.stringify(document)));
            callback(null);
            if (document.nodeid === node._id) finish();
        }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    plugin.hook_agentCoreIsStable({ dbNodeKey: node._id });
    await Promise.race([completed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('sync timed out')), 1000))]);
    assert.equal(Array.from(records.values()).filter((record) => record.type === 'inventoryasset').length, 2);
    assert.equal(records.get(peripheral._id).nodeid, '');
    const workstation = Array.from(records.values()).find((asset) => asset.type === 'inventoryasset' && asset.assetKind !== 'peripheral');
    assert.equal(workstation.nodeid, node._id);
    assert.equal(workstation.identity.serial, 'SHARED-SERIAL');
});

test('manual workstation creation blocks identifiers already used by automatic inventory', async () => {
    const automatic = {
        _id: 'inventoryasset//automatic-1', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        name: 'DEMO-LAP-010', identity: { serial: 'SERIAL-010', uuid: '10101010-1010-4010-8010-101010101010' },
        nodeid: 'node//device-10', nodeids: ['node//device-10'], meshid: 'mesh//group-1',
        automatic: { assetTagReported: 'TAG-010', nodeExists: true }, manual: { assetTag: '' },
        assignment: { mode: 'unassigned', assignees: [], pending: [] }, history: []
    };
    const records = new Map([[automatic._id, automatic]]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, Array.from(records.values()).filter((record) => record.type === type)); },
        Set(document, callback) { records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    let requestId = 0;
    const invoke = (command) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction(Object.assign({ requestId: `manual-workstation-${++requestId}` }, command), session);
    });

    let response = await invoke({ pluginaction: 'workstation-create', workstation: { name: 'Duplicate PC', serial: 'serial-010' } });
    assert.equal(response.ok, false);
    assert.match(response.error, /Serial number already belongs to DEMO-LAP-010/);
    response = await invoke({ pluginaction: 'workstation-create', workstation: {
        name: 'Spare laptop', serial: 'MANUAL-011', uuid: '11111111-2222-4333-8444-555555555555', asset_tag: 'TAG-011'
    } });
    assert.equal(response.ok, true);
    assert.equal(response.result.kind, 'workstation-created');
    assert.equal(response.result.asset.source, 'manual');
    assert.equal(response.result.asset.nodeid, '');
    assert.equal(Array.from(records.values()).filter((record) => record.type === 'inventoryasset').length, 2);
});

test('an agent never merges into a manual workstation and both records receive a duplicate warning', async () => {
    const node = { _id: 'node//device-20', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-020', users: [], agent: { id: 4, ver: 126 } };
    const sysinfo = {
        _id: `si${node._id}`, time: 1000,
        hardware: { identifiers: { chassis_serial: 'COLLISION-020', product_uuid: '20202020-2020-4020-8020-202020202020' } }
    };
    const manual = {
        _id: 'inventoryasset//manual-20', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'manual',
        name: 'Manually recorded laptop', identity: { serial: 'COLLISION-020', uuid: '' }, nodeid: '', nodeids: [], meshid: '',
        automatic: { online: false, nodeExists: false }, manualHardware: {}, manual: { assetTag: '' },
        assignment: { mode: 'unassigned', assignees: [], pending: [], initialized: true }, duplicateConflicts: [], history: []
    };
    const records = new Map([[manual._id, manual]]);
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const database = {
        Get(id, callback) {
            if (id === node._id) return callback(null, [node]);
            if (id === `si${node._id}`) return callback(null, [sysinfo]);
            callback(null, records.has(id) ? [records.get(id)] : []);
        },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, Array.from(records.values()).filter((record) => record.type === type)); },
        Set(document, callback) {
            records.set(document._id, JSON.parse(JSON.stringify(document)));
            callback(null);
            const values = Array.from(records.values()).filter((record) => record.type === 'inventoryasset');
            if (values.length === 2 && values.every((asset) => (asset.duplicateConflicts || []).length === 1)) finish();
        }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    plugin.hook_agentCoreIsStable({ dbNodeKey: node._id });
    await Promise.race([completed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('duplicate reconciliation timed out')), 1000))]);
    assert.equal(Array.from(records.values()).filter((record) => record.type === 'inventoryasset').length, 2);
    assert.equal(records.get(manual._id).nodeid, '');
    const automatic = Array.from(records.values()).find((asset) => asset.source === 'automatic');
    assert.ok(automatic);
    assert.equal(automatic.nodeid, node._id);
    assert.equal(automatic.duplicateConflicts[0].otherAssetId, manual._id);
    assert.equal(records.get(manual._id).duplicateConflicts[0].otherAssetId, automatic._id);
});

test('inventory list is read-only and only returns assets in the users accessible scopes', async () => {
    const assets = [
        {
            _id: 'inventoryasset//allowed-workstation', type: 'inventoryasset', domain: '',
            assetKind: 'workstation', source: 'automatic', meshid: 'mesh//allowed', name: 'VISIBLE-PC',
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//denied-workstation', type: 'inventoryasset', domain: '',
            assetKind: 'workstation', source: 'automatic', meshid: 'mesh//denied', name: 'HIDDEN-PC',
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//manual-workstation', type: 'inventoryasset', domain: '',
            assetKind: 'workstation', source: 'manual', name: 'ADMIN-ONLY-MANUAL',
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//allowed-peripheral', type: 'inventoryasset', domain: '',
            assetKind: 'peripheral', source: 'manual', name: 'VISIBLE-MOUSE', scope: { meshid: 'mesh//allowed' },
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//denied-peripheral', type: 'inventoryasset', domain: '',
            assetKind: 'peripheral', source: 'manual', name: 'HIDDEN-KEYBOARD', scope: { meshid: 'mesh//denied' },
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//unscoped-peripheral', type: 'inventoryasset', domain: '',
            assetKind: 'peripheral', source: 'manual', name: 'ADMIN-ONLY-MOUSE',
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//domain-peripheral', type: 'inventoryasset', domain: '',
            assetKind: 'peripheral', source: 'manual', name: 'DOMAIN-HEADSET', scope: { kind: 'domain' },
            identity: {}, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        }
    ];
    let inventoryReads = 0;
    let writes = 0;
    const database = {
        Get() {},
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'inventoryasset') inventoryReads++;
            callback(null, type === 'inventoryasset' ? assets : []);
        },
        Set(document, callback) { writes++; callback(null); },
        Remove() {}
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { GetAllMeshIdWithRights() { return ['mesh//allowed']; } },
            config: { domains: { '': {} } }
        },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//operator', domain: '', siteadmin: 0 },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'scoped-list', pluginaction: 'list' }, session);
    });

    assert.equal(response.ok, true);
    assert.deepEqual(response.result.assets.map((asset) => asset.name), ['DOMAIN-HEADSET', 'VISIBLE-MOUSE', 'VISIBLE-PC']);
    assert.equal(response.result.capabilities.canCreateManualWorkstation, false);
    assert.equal(inventoryReads, 1);
    assert.equal(writes, 0);
});

test('a scoped manager cannot link a peripheral to a workstation outside their device groups', async () => {
    const assets = [
        {
            _id: 'inventoryasset//allowed-workstation', type: 'inventoryasset', domain: '',
            assetKind: 'workstation', source: 'automatic', meshid: 'mesh//allowed', name: 'VISIBLE-PC',
            identity: { serial: 'VISIBLE-SERIAL' }, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        },
        {
            _id: 'inventoryasset//denied-workstation', type: 'inventoryasset', domain: '',
            assetKind: 'workstation', source: 'automatic', meshid: 'mesh//denied', name: 'HIDDEN-PC',
            identity: { serial: 'HIDDEN-SERIAL' }, automatic: {}, manual: {}, assignment: { assignees: [], pending: [] }
        }
    ];
    const database = {
        Get() {}, Set() {}, Remove() {},
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? assets : []); }
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { GetAllMeshIdWithRights() { return ['mesh//allowed']; } },
            config: { domains: { '': {} } }
        },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//manager', domain: '', siteadmin: 0 },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const invoke = (rows) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: `scoped-preview-${rows[0].rowNumber}`, pluginaction: 'peripheral-preview', rows }, session);
    });

    let response = await invoke([{ rowNumber: 2, type: 'Mouse', name: 'Mouse', linked_workstation: 'HIDDEN-SERIAL' }]);
    assert.equal(response.ok, true);
    assert.equal(response.result.rows[0].linkedWorkstation, null);
    assert.ok(response.result.rows[0].errors.some((error) => error.includes('was not found')));
    assert.ok(response.result.rows[0].errors.some((error) => error.includes('accessible device group')));

    response = await invoke([{ rowNumber: 3, type: 'Mouse', name: 'Mouse', linked_workstation: 'VISIBLE-SERIAL' }]);
    assert.equal(response.ok, true);
    assert.deepEqual(response.result.rows[0].errors, []);
    assert.equal(response.result.rows[0].linkedWorkstation.name, 'VISIBLE-PC');
});

test('manual workstation creation is restricted to full administrators', async () => {
    let writes = 0;
    const database = {
        Get(id, callback) { callback(null, []); }, Remove() {},
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, []); },
        Set(document, callback) { writes++; callback(null); }
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { GetAllMeshIdWithRights() { return ['mesh//allowed']; } },
            config: { domains: { '': {} } }
        },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//manager', domain: '', siteadmin: 0 },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({
            requestId: 'manual-workstation-denied', pluginaction: 'workstation-create',
            workstation: { name: 'Unauthorized manual workstation', serial: 'NOPE-001' }
        }, session);
    });

    assert.equal(response.ok, false);
    assert.match(response.error, /full administrator/i);
    assert.equal(writes, 0);
});

test('full synchronization loads the inventory collection once for all nodes', async () => {
    const nodes = [
        { _id: 'node//one', domain: '', meshid: 'mesh//group-1', name: 'PC-ONE', users: [], agent: { id: 4, ver: 126 } },
        { _id: 'node//two', domain: '', meshid: 'mesh//group-1', name: 'PC-TWO', users: [], agent: { id: 4, ver: 126 } },
        { _id: 'node//three', domain: '', meshid: 'mesh//group-1', name: 'PC-THREE', users: [], agent: { id: 4, ver: 126 } }
    ];
    const sysinfos = nodes.map((node, index) => ({
        _id: `si${node._id}`, domain: '', type: 'sysinfo', time: 1000 + index,
        hardware: { identifiers: {
            chassis_serial: `SERIAL-${index + 1}`,
            product_uuid: `00000000-0000-4000-8000-00000000000${index + 1}`
        } }
    }));
    const existingWorkstation = {
        _id: 'inventoryasset//existing-one', type: 'inventoryasset', domain: '',
        assetKind: 'workstation', source: 'automatic', nodeid: nodes[0]._id, nodeids: [nodes[0]._id],
        meshid: 'mesh//group-1', name: 'PC-ONE', identity: { serial: 'SERIAL-1', uuid: '00000000-0000-4000-8000-000000000001' },
        automatic: { nodeExists: true }, manual: {}, assignment: { assignees: [], pending: [] }, history: []
    };
    const linkedPeripheral = {
        _id: 'inventoryasset//linked-mouse', type: 'inventoryasset', domain: '',
        assetKind: 'peripheral', source: 'manual', name: 'PC-ONE mouse', identity: { serial: 'MOUSE-ONE' },
        links: { workstationAssetId: existingWorkstation._id, workstationName: existingWorkstation.name },
        automatic: {}, manual: {}, peripheral: { type: 'Mouse' }, assignment: { assignees: [], pending: [] }, history: []
    };
    const unlinkedPeripheral = {
        _id: 'inventoryasset//unlinked-headset', type: 'inventoryasset', domain: '',
        assetKind: 'peripheral', source: 'manual', name: 'Shared headset', identity: { serial: 'HEADSET-ONE' },
        links: {}, automatic: {}, manual: {}, peripheral: { type: 'Headset' },
        assignment: { assignees: [], pending: [] }, history: []
    };
    let inventoryReads = 0;
    const saved = [];
    const database = {
        Get(id, callback) { callback(null, []); }, Remove() {},
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'node') return callback(null, nodes);
            if (type === 'sysinfo') return callback(null, sysinfos);
            if (type === 'lastconnect') return callback(null, []);
            if (type === 'inventoryasset') {
                inventoryReads++;
                return callback(null, [existingWorkstation, linkedPeripheral, unlinkedPeripheral]);
            }
            callback(null, []);
        },
        Set(document, callback) { saved.push(JSON.parse(JSON.stringify(document))); callback(null); }
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { meshes: { 'mesh//group-1': { name: 'Managed PCs' } }, wsagents: {} },
            config: { domains: { '': {} } }
        },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'one-pass-rescan', pluginaction: 'rescan' }, session);
    });

    assert.equal(response.ok, true);
    assert.equal(inventoryReads, 1);
    assert.equal(new Set(saved.map((asset) => asset.nodeid).filter(Boolean)).size, 3);
    const savedPeripheral = saved.find((asset) => asset._id === linkedPeripheral._id);
    assert.equal(savedPeripheral.scope.kind, 'mesh');
    assert.equal(savedPeripheral.scope.meshid, 'mesh//group-1');
    assert.equal(savedPeripheral.links.workstationMeshId, 'mesh//group-1');
    const savedUnlinkedPeripheral = saved.find((asset) => asset._id === unlinkedPeripheral._id);
    assert.equal(savedUnlinkedPeripheral.scope.kind, 'domain');
    assert.ok(saved.some((record) => record._id === linkedPeripheral._id.replace('inventoryasset/', 'inventoryassetbackup/')));
    assert.ok(saved.some((record) => record._id === unlinkedPeripheral._id.replace('inventoryasset/', 'inventoryassetbackup/')));
});

test('trusted scans restore a missing peripheral from its preservation copy', async () => {
    const peripheral = {
        _id: 'inventoryasset//preserved-mouse', type: 'inventoryasset', domain: '',
        assetKind: 'peripheral', source: 'manual', name: 'Preserved mouse', status: 'Available',
        identity: { serial: 'PRESERVED-001', uuid: '' }, peripheral: { type: 'Mouse' },
        scope: { kind: 'domain' }, links: {}, manual: {}, automatic: {},
        assignment: { mode: 'unassigned', assignees: [], pending: [] }, history: [], updatedAt: 1000
    };
    const backupId = peripheral._id.replace('inventoryasset/', 'inventoryassetbackup/');
    const backup = {
        _id: backupId, type: 'inventoryassetbackup', domain: '', assetId: peripheral._id,
        asset: JSON.parse(JSON.stringify(peripheral)), updatedAt: 1000
    };
    const records = new Map([[backup._id, backup]]);
    let removes = 0;
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) {
            callback(null, Array.from(records.values()).filter((record) => record.type === type && record.domain === domain));
        },
        Set(document, callback) { records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { removes++; records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'restore-preserved-peripheral', pluginaction: 'rescan' }, session);
    });

    assert.equal(response.ok, true);
    assert.equal(removes, 0);
    const restored = records.get(peripheral._id);
    assert.ok(restored);
    assert.equal(restored.assetKind, 'peripheral');
    assert.ok(restored.history.some((entry) => entry.action === 'asset.restored'));
    assert.equal(records.get(backupId).assetId, peripheral._id);
});

test('automatic workstation updates reject invalid dates without writing', async () => {
    const asset = {
        _id: 'inventoryasset//automatic-date', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: 'node//date', nodeids: ['node//date'], meshid: 'mesh//group-1', name: 'DATE-PC', status: 'Available',
        identity: {}, automatic: { nodeExists: true }, manual: { purchaseDate: '' },
        assignment: { mode: 'unassigned', assignees: [], pending: [] }, history: []
    };
    let writes = 0;
    const database = {
        Get(id, callback) { callback(null, id === asset._id ? [asset] : []); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? [asset] : []); },
        Set(document, callback) { writes++; callback(null); }, Remove() {}
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({
            requestId: 'invalid-date', pluginaction: 'update', assetId: asset._id,
            changes: { purchaseDate: 'not-a-date' }
        }, session);
    });

    assert.equal(response.ok, false);
    assert.match(response.error, /Purchase date must be/);
    assert.equal(writes, 0);
    assert.equal(asset.manual.purchaseDate, '');
    const assignedResponse = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({
            requestId: 'invalid-assignment', pluginaction: 'update', assetId: asset._id,
            changes: { status: 'Assigned' }
        }, session);
    });
    assert.equal(assignedResponse.ok, false);
    assert.match(assignedResponse.error, /requires an assignee/);
    assert.equal(writes, 0);
});

test('unchanged asset updates do not write or append audit history', async () => {
    const commonManual = { assetTag: 'TAG-1', location: 'Office', purchaseDate: '2025-01-02', warrantyEnd: '2028-01-02', notes: 'Kept' };
    const automatic = {
        _id: 'inventoryasset//unchanged-auto', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: 'node//unchanged-auto', nodeids: ['node//unchanged-auto'], meshid: 'mesh//group-1', name: 'AUTO-PC', status: 'Available',
        identity: { serial: 'AUTO-001', uuid: '' }, automatic: { nodeExists: true }, manual: Object.assign({}, commonManual),
        assignment: { mode: 'unassigned', assignees: [], pending: [], initialized: false }, history: []
    };
    const manualWorkstation = {
        _id: 'inventoryasset//unchanged-manual', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'manual',
        nodeid: '', nodeids: [], name: 'MANUAL-PC', status: 'Assigned',
        identity: { serial: 'MANUAL-001', uuid: '11111111-2222-4333-8444-555555555555' },
        manualHardware: { manufacturer: 'Dell', model: 'Latitude', osName: 'Windows 11' }, manual: Object.assign({}, commonManual),
        assignment: { mode: 'single', assignees: [{ id: 'user@example.test', display: 'user@example.test' }], pending: [], initialized: true },
        reviews: [], identityConflicts: [], duplicateConflicts: [], history: []
    };
    const peripheral = {
        _id: 'inventoryasset//unchanged-peripheral', type: 'inventoryasset', domain: '', assetKind: 'peripheral', source: 'manual',
        nodeid: '', nodeids: [], name: 'Desk mouse', status: 'Assigned', identity: { serial: 'MOUSE-001', uuid: '' },
        peripheral: { type: 'Mouse', manufacturer: 'Logitech', model: 'M100' }, links: {}, scope: { kind: 'domain' }, manual: Object.assign({}, commonManual),
        assignment: { mode: 'single', assignees: [{ id: 'user@example.test', display: 'user@example.test' }], pending: [], initialized: true }, history: []
    };
    const records = new Map([automatic, manualWorkstation, peripheral].map((asset) => [asset._id, asset]));
    let writes = 0;
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? Array.from(records.values()) : []); },
        Set(document, callback) { writes++; records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove() {}
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const invoke = (assetId, changes) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: `unchanged-${assetId}`, pluginaction: 'update', assetId, changes }, session);
    });
    const baseChanges = Object.assign({ status: 'Assigned' }, commonManual);

    let response = await invoke(automatic._id, Object.assign({}, commonManual, { status: 'Available' }));
    assert.equal(response.ok, true);
    assert.equal(response.result.unchanged, true);

    response = await invoke(manualWorkstation._id, Object.assign({}, baseChanges, {
        name: 'MANUAL-PC', serial: 'MANUAL-001', uuid: '11111111-2222-4333-8444-555555555555',
        manufacturer: 'Dell', model: 'Latitude', osName: 'Windows 11', assignedUser: 'user@example.test'
    }));
    assert.equal(response.ok, true);
    assert.equal(response.result.unchanged, true);

    response = await invoke(peripheral._id, Object.assign({}, baseChanges, {
        peripheralType: 'Mouse', name: 'Desk mouse', serial: 'MOUSE-001', manufacturer: 'Logitech', model: 'M100',
        assignedUser: 'user@example.test', linkedWorkstation: ''
    }));
    assert.equal(response.ok, true);
    assert.equal(response.result.unchanged, true);
    assert.equal(writes, 0);
    for (const asset of records.values()) assert.deepEqual(asset.history, []);
});

test('device-group removal policy drives stale review and settings remain admin-only', async () => {
    const now = Date.now();
    const node = { _id: 'node//policy', type: 'node', domain: '', meshid: 'mesh//policy', name: 'POLICY-PC', agent: { id: 4 } };
    const asset = {
        _id: 'inventoryasset//policy', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: node._id, nodeids: [node._id], meshid: node.meshid, name: node.name, status: 'Available',
        identity: { serial: 'POLICY-SERIAL', uuid: '' }, automatic: { lastSeen: now - 11 * 86400000, nodeExists: true, online: false },
        manual: {}, assignment: { mode: 'unassigned', assignees: [], pending: [{ id: 'example\\serviceaccount', display: 'EXAMPLE\\serviceaccount' }], initialized: true }, history: []
    };
    const records = new Map([[asset._id, asset]]);
    let writes = 0;
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'node') return callback(null, [node]);
            if (type === 'sysinfo') return callback(null, [{ _id: `si${node._id}`, type: 'sysinfo', domain: '', hardware: { identifiers: { chassis_serial: 'POLICY-SERIAL' } } }]);
            if (type === 'lastconnect') return callback(null, [{ _id: `lc${node._id}`, type: 'lastconnect', domain: '', meshid: node.meshid, time: now - 11 * 86400000 }]);
            callback(null, type === 'inventoryasset' ? [records.get(asset._id)] : []);
        },
        Set(document, callback) { writes++; records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove() {}
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { meshes: { [node.meshid]: { _id: node.meshid, domain: '', name: 'Policy group', expireDevs: 10 } }, wsagents: {} },
            config: { domains: { '': { autoremoveinactivedevices: 40 } } }
        },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const invoke = (pluginaction, extra) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction(Object.assign({ requestId: pluginaction, pluginaction }, extra || {}), session);
    });
    let response = await invoke('rescan');
    assert.equal(response.ok, true);
    assert.deepEqual(records.get(asset._id).reviews.map((item) => item.reason), ['stale-device']);
    const beforeList = writes;
    response = await invoke('list');
    assert.equal(response.ok, true);
    assert.equal(writes, beforeList);
    response = await invoke('settings-update', { settings: { mode: 'custom', days: 12, ignoredUsers: ['ServiceAccount'] } });
    assert.equal(response.ok, true);
    assert.match(response.result.settingsWarning, /may disappear/);
    assert.equal(records.get('inventorysettings/').days, 12);
    assert.deepEqual(records.get('inventorysettings/').ignoredUsers, ['serviceaccount']);
    assert.deepEqual(records.get(asset._id).assignment.pending, []);
    assert.deepEqual(records.get(asset._id).reviews, []);
    response = await invoke('settings-update', { settings: { mode: 'custom', days: 13 } });
    assert.equal(response.ok, true);
    assert.deepEqual(records.get('inventorysettings/').ignoredUsers, ['serviceaccount']);
    response = await invoke('settings-update', { settings: { mode: 'custom', days: 13, ignoredUsers: ['bad,*'] } });
    assert.equal(response.ok, false);
    assert.deepEqual(records.get('inventorysettings/').ignoredUsers, ['serviceaccount']);
    session.user = { _id: 'user//scoped', domain: '', siteadmin: 0 };
    response = await invoke('settings-update', { settings: { mode: 'disabled', days: 30 } });
    assert.equal(response.ok, false);
    assert.match(response.error, /full administrator/);
});

test('full synchronization consolidates pre-linked automatic records with the same hardware identity', async () => {
    const nodes = [
        { _id: 'node//old', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-003', users: [], agent: { id: 4, ver: 126 } },
        { _id: 'node//new', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-003', users: [], agent: { id: 4, ver: 126 } }
    ];
    const identity = { chassis_serial: 'F2HKMJ2', product_uuid: '4c4c4544-0032-4810-804b-c6c04f4d4a32' };
    const sysinfos = nodes.map((node, index) => ({
        _id: `si${node._id}`, domain: '', type: 'sysinfo', time: 1000 + index,
        hardware: { identifiers: identity }
    }));
    const records = new Map([
        ['inventoryasset//older', {
            _id: 'inventoryasset//older', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
            createdAt: 1, updatedAt: 10, nodeid: nodes[0]._id, nodeids: [nodes[0]._id], meshid: 'mesh//group-1', name: 'DEMO-LAP-003',
            identity: { serial: 'F2HKMJ2', uuid: identity.product_uuid }, automatic: { online: false }, manual: { location: 'HQ' },
            assignment: { mode: 'single', assignees: [{ id: 'first@example.test', display: 'first@example.test' }], pending: [], resolutions: [], initialized: true },
            reviews: [], observedUsers: [], identityConflicts: [], identityResolutions: [], duplicateConflicts: [], history: []
        }],
        ['inventoryasset//newer', {
            _id: 'inventoryasset//newer', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
            createdAt: 2, updatedAt: 20, nodeid: nodes[1]._id, nodeids: [nodes[1]._id], meshid: 'mesh//group-1', name: 'DEMO-LAP-003',
            identity: { serial: 'F2HKMJ2', uuid: identity.product_uuid }, automatic: { online: true }, manual: { notes: 'Preserve this note' },
            assignment: { mode: 'single', assignees: [{ id: 'second@example.test', display: 'second@example.test' }], pending: [], resolutions: [], initialized: true },
            reviews: [], observedUsers: [], identityConflicts: [], identityResolutions: [], duplicateConflicts: [], history: []
        }]
    ]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'node') return callback(null, nodes);
            if (type === 'sysinfo') return callback(null, sysinfos);
            if (type === 'lastconnect') return callback(null, [{ _id: `lc${nodes[1]._id}`, type: 'lastconnect', time: 5000 }]);
            if (type === 'inventoryasset') return callback(null, Array.from(records.values()).map((record) => {
                const returned = JSON.parse(JSON.stringify(record));
                delete returned.type;
                return returned;
            }));
            callback(null, []);
        },
        Set(document, callback) { if (document.type === 'inventoryasset') records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: {
            db: database,
            GetConnectivityState(nodeid) { return { connectivity: nodeid === nodes[1]._id ? 1 : 0 }; },
            webserver: { meshes: { 'mesh//group-1': { name: 'Managed PCs' } }, wsagents: {} },
            config: { domains: { '': {} } }
        },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'consolidate-duplicates', pluginaction: 'rescan' }, session);
    });
    assert.equal(response.ok, true);
    assert.equal(records.size, 1);
    const consolidated = Array.from(records.values())[0];
    assert.equal(consolidated.type, 'inventoryasset');
    assert.deepEqual(consolidated.nodeids.sort(), nodes.map((node) => node._id).sort());
    assert.deepEqual(consolidated.assignment.assignees.map((user) => user.id).sort(), ['first@example.test', 'second@example.test']);
    assert.equal(consolidated.manual.location, 'HQ');
    assert.equal(consolidated.manual.notes, 'Preserve this note');
    assert.equal(consolidated.mergedRecords.length, 1);
    assert.ok(consolidated.reviews.some((review) => review.reason === 'duplicate-records-consolidated'));
    assert.ok(consolidated.history.some((entry) => entry.action === 'workstation.duplicate-consolidated'));
});

test('full synchronization preserves and flags automatic records when hardware identifiers conflict', async () => {
    const nodes = [
        { _id: 'node//left', domain: '', meshid: 'mesh//group-1', name: 'DEMO-PC-009', users: [], agent: { id: 4, ver: 126 } },
        { _id: 'node//right', domain: '', meshid: 'mesh//group-1', name: 'DEMO-PC-009', users: [], agent: { id: 4, ver: 126 } }
    ];
    const identities = [
        { chassis_serial: 'SERIAL-009', product_uuid: '09000000-0000-4000-8000-000000000001' },
        { chassis_serial: 'SERIAL-009', product_uuid: '09000000-0000-4000-8000-000000000002' }
    ];
    const records = new Map(nodes.map((node, index) => [`inventoryasset//${index}`, {
        _id: `inventoryasset//${index}`, type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        createdAt: index + 1, updatedAt: 10 + index, nodeid: node._id, nodeids: [node._id], meshid: node.meshid, name: node.name,
        identity: { serial: identities[index].chassis_serial, uuid: identities[index].product_uuid }, automatic: { assetTagReported: 'NO Asset Tag' }, manual: {},
        assignment: { mode: 'unassigned', assignees: [], pending: [], resolutions: [], initialized: true },
        reviews: [], observedUsers: [], identityConflicts: [], identityResolutions: [], duplicateConflicts: [], history: []
    }]));
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'node') return callback(null, nodes);
            if (type === 'sysinfo') return callback(null, nodes.map((node, index) => ({
                _id: `si${node._id}`, domain: '', type: 'sysinfo', time: 1000 + index,
                hardware: { identifiers: identities[index] }
            })));
            if (type === 'lastconnect') return callback(null, []);
            if (type === 'inventoryasset') return callback(null, Array.from(records.values()));
            callback(null, []);
        },
        Set(document, callback) { if (document.type === 'inventoryasset') records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: {
            db: database,
            webserver: { meshes: { 'mesh//group-1': { name: 'Managed PCs' } }, wsagents: {} },
            config: { domains: { '': {} } }
        },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'preserve-conflict', pluginaction: 'rescan' }, session);
    });
    assert.equal(response.ok, true);
    assert.equal(records.size, 2);
    for (const asset of records.values()) {
        assert.equal(asset.duplicateConflicts.length, 1);
        assert.deepEqual(asset.duplicateConflicts[0].matches, ['serial']);
        assert.deepEqual(asset.duplicateConflicts[0].conflicts, ['UUID']);
    }
});

test('full synchronization ignores repeated reported asset tags when hardware identity differs', async () => {
    const nodes = [
        { _id: 'node//tag-left', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-101', users: [] },
        { _id: 'node//tag-right', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-102', users: [] }
    ];
    const identities = [
        { chassis_serial: 'SERIAL-101', product_uuid: '10100000-0000-4000-8000-000000000101', chassis_assettag: 'NO Asset Tag' },
        { chassis_serial: 'SERIAL-102', product_uuid: '10200000-0000-4000-8000-000000000102', chassis_assettag: 'NO Asset Tag' }
    ];
    const records = new Map(nodes.map((node, index) => [`inventoryasset//tag-${index}`, {
        _id: `inventoryasset//tag-${index}`, type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        createdAt: index + 1, nodeid: node._id, nodeids: [node._id], meshid: node.meshid, name: node.name,
        identity: { serial: identities[index].chassis_serial, uuid: identities[index].product_uuid },
        automatic: { assetTagReported: 'NO Asset Tag' }, manual: {},
        assignment: { assignees: [], pending: [], resolutions: [] }, duplicateConflicts: [], reviews: [], history: []
    }]));
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'node') return callback(null, nodes);
            if (type === 'sysinfo') return callback(null, nodes.map((node, index) => ({
                _id: `si${node._id}`, domain: '', time: 1000 + index, hardware: { identifiers: identities[index] }
            })));
            if (type === 'inventoryasset') return callback(null, Array.from(records.values()));
            callback(null, []);
        },
        Set(document, callback) { if (document.type === 'inventoryasset') records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'ignore-reported-tag', pluginaction: 'rescan' }, session);
    });
    assert.equal(response.ok, true);
    assert.equal(records.size, 2);
    for (const asset of records.values()) assert.deepEqual(asset.duplicateConflicts, []);
});

test('full synchronization restores inventory records hidden by a missing type field', async () => {
    const node = { _id: 'node//hidden', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-103', users: [] };
    const hidden = {
        _id: 'inventoryasset//hidden', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: node._id, nodeids: [node._id], meshid: node.meshid, name: node.name,
        identity: { serial: 'SERIAL-103', uuid: '10300000-0000-4000-8000-000000000103' }, automatic: {}, manual: {},
        assignment: { mode: 'single', assignees: [{ id: 'preserved@example.test', display: 'preserved@example.test' }], pending: [], resolutions: [] },
        duplicateConflicts: [{ kind: 'automatic-identity-duplicate', matches: ['asset tag'] }], reviews: [], history: []
    };
    const hiddenPeripheral = {
        _id: 'inventoryasset//old-peripheral', domain: '', assetKind: 'peripheral', source: 'manual',
        nodeid: '', nodeids: [], name: 'OLD-MONITOR', identity: { serial: '', uuid: '' }, peripheral: { type: 'Monitor' },
        assignment: { assignees: [], pending: [] }, history: []
    };
    const records = new Map([[hidden._id, hidden], [hiddenPeripheral._id, hiddenPeripheral]]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAll(callback) { callback(null, Array.from(records.values())); },
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'node') return callback(null, [node]);
            if (type === 'sysinfo') return callback(null, [{
                _id: `si${node._id}`, domain: '', time: 1000,
                hardware: { identifiers: { chassis_serial: hidden.identity.serial, product_uuid: hidden.identity.uuid } }
            }]);
            if (type === 'inventoryasset') return callback(null, Array.from(records.values()).filter((record) => record.type === 'inventoryasset'));
            callback(null, []);
        },
        Set(document, callback) { records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'restore-untyped', pluginaction: 'rescan' }, session);
    });
    assert.equal(response.ok, true);
    const restored = records.get(hidden._id);
    assert.equal(restored.type, 'inventoryasset');
    assert.equal(restored.assignment.assignees[0].id, 'preserved@example.test');
    assert.deepEqual(restored.duplicateConflicts, []);
    assert.ok(restored.history.some((entry) => entry.action === 'asset.type-restored'));
    assert.equal(records.get(hiddenPeripheral._id).type, undefined);
    assert.equal(records.get('inventorymigration/type-field-v2').complete, true);
    assert.equal(records.get('inventorymigration/type-field-v2').recovered, 1);
});

test('agent synchronization waits for type-field recovery before matching a workstation', async () => {
    const node = { _id: 'node//early-agent', type: 'node', domain: '', meshid: 'mesh//group-1', name: 'EARLY-PC', users: [] };
    const sysinfo = {
        _id: `si${node._id}`, type: 'sysinfo', domain: '', time: 1000,
        hardware: { identifiers: { chassis_serial: 'EARLY-001', product_uuid: 'eeeeeeee-0000-4000-8000-000000000001' } }
    };
    const hidden = {
        _id: 'inventoryasset//early-hidden', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: node._id, nodeids: [node._id], meshid: node.meshid, name: node.name, status: 'Assigned',
        identity: { serial: 'EARLY-001', uuid: 'eeeeeeee-0000-4000-8000-000000000001' }, automatic: {}, manual: {},
        assignment: { mode: 'single', assignees: [{ id: 'preserved@example.test', display: 'preserved@example.test' }], pending: [], resolutions: [], initialized: true },
        duplicateConflicts: [], reviews: [], history: []
    };
    const records = new Map([[node._id, node], [sysinfo._id, sysinfo], [hidden._id, hidden]]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAll(callback) { callback(null, Array.from(records.values())); },
        GetAllTypeNoTypeField(type, domain, callback) {
            callback(null, Array.from(records.values()).filter((record) => record.type === type && record.domain === domain));
        },
        Set(document, callback) { records.set(document._id, JSON.parse(JSON.stringify(document))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: { meshes: {}, wsagents: {} }, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    await plugin.hook_agentCoreIsStable({ dbNodeKey: node._id });

    const workstations = Array.from(records.values()).filter((record) => record.type === 'inventoryasset' && record.assetKind === 'workstation');
    assert.equal(workstations.length, 1);
    assert.equal(workstations[0]._id, hidden._id);
    assert.equal(workstations[0].assignment.assignees[0].id, 'preserved@example.test');
    assert.equal(records.get('inventorymigration/type-field-v2').complete, true);
});

test('inventory list overlays live connectivity and reports every current MeshCentral record without writing', async () => {
    const asset = {
        _id: 'inventoryasset//multi-node', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: 'node//old', nodeids: ['node//old', 'node//new'], meshid: 'mesh//group-1', name: 'DEMO-LAP-027',
        identity: { serial: 'SERIAL-027', uuid: '27000000-0000-4000-8000-000000000027' },
        automatic: { online: false, nodeExists: true, condition: 'Offline' }, manual: {},
        assignment: { mode: 'unassigned', assignees: [], pending: [] }, reviews: [], identityConflicts: [], duplicateConflicts: []
    };
    let writes = 0;
    const database = {
        Get(id, callback) { callback(null, []); },
        GetAllTypeNoTypeField(type, domain, callback) {
            if (type === 'inventoryasset') return callback(null, [asset]);
            if (type === 'node') return callback(null, [
                { _id: 'node//old', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-027 old' },
                { _id: 'node//new', domain: '', meshid: 'mesh//group-1', name: 'DEMO-LAP-027' }
            ]);
            if (type === 'lastconnect') return callback(null, [{ _id: 'lcnode//new', time: 9000 }]);
            callback(null, []);
        },
        Set(document, callback) { writes++; callback(null); }, Remove() {}
    };
    const pluginHandler = {
        parent: {
            db: database,
            GetConnectivityState(nodeid) { return { connectivity: nodeid === 'node//new' ? 1 : 0 }; },
            webserver: { GetAllMeshIdWithRights() { return ['mesh//group-1']; }, meshes: {}, wsagents: {} },
            config: { domains: { '': {} } }
        },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'live-list', pluginaction: 'list' }, session);
    });
    assert.equal(response.ok, true);
    assert.equal(writes, 0);
    assert.equal(response.result.assets[0].automatic.online, true);
    assert.equal(response.result.assets[0].automatic.condition, 'Online');
    assert.equal(response.result.assets[0].linkedNodeCount, 2);
    assert.deepEqual(response.result.assets[0].linkedNodes.map((node) => [node.name, node.online]), [['DEMO-LAP-027', true], ['DEMO-LAP-027 old', false]]);
    assert.equal(response.result.summary.review, 1);
});

test('dashboard search is limited to asset name and assigned user', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'inventory.handlebars'), 'utf8');
    const filteredStart = view.indexOf('function filteredAssets()');
    const filteredEnd = view.indexOf('function renderRows()', filteredStart);
    const filteredSource = view.substring(filteredStart, filteredEnd);
    assert.match(filteredSource, /var haystack = \[asset\.name, assignmentText\(asset\)\]/);
    assert.doesNotMatch(filteredSource, /identity\.uuid|identity\.serial|manual\.location|automatic\.model/);
    assert.match(view, /Search device or assigned user/);
});

test('dashboard actions share the inventory tab row and detail saves track dirty state in the browser', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'inventory.handlebars'), 'utf8');
    const tabbarStart = view.indexOf('<div class="inv-tabbar">');
    const settingsStart = view.indexOf('<section class="inv-section inv-hidden" id="settingsPanel">');
    const tabbar = view.substring(tabbarStart, settingsStart);
    assert.ok(tabbarStart >= 0);
    assert.match(tabbar, /id="inventoryTabs"/);
    for (const id of ['exportButton', 'rescanButton', 'settingsButton', 'addWorkstationButton', 'templateButton', 'importButton', 'addPeripheralButton']) {
        assert.match(tabbar, new RegExp(`id="${id}"`));
    }
    assert.doesNotMatch(view, /inv-dashboard-actions/);
    assert.match(view, /No changes to save\./);
    assert.match(view, /function updateDetailDirty\(\)/);
    assert.match(view, /JSON\.stringify\(detailFormValue\(\)\) !== state\.detailBaseline/);
    assert.match(view, /id="saveButton"[^>]*disabled/);
    assert.match(view, /id="revertButton"[^>]*disabled/);
    assert.match(view, /id="downloadBackupButton"/);
    assert.match(view, /id="restoreBackupButton"/);
    assert.match(view, /new Blob\(\[text\]/);
    assert.match(view, /confirm: 'RESTORE INVENTORY'/);
});

test('browser application script is valid JavaScript after boot data is rendered', () => {
    const template = fs.readFileSync(path.join(root, 'views', 'inventory.handlebars'), 'utf8');
    assert.match(template, /id="typeFilter"/);
    assert.match(template, /All peripheral types/);
    const blocks = [...template.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.equal(blocks.length, 2);
    const rendered = blocks.join('\n').replace('{{{boot}}}', JSON.stringify({
        nodeid: '', mode: 'dashboard', user: {}, permissions: ['can_view'], lifecycleStates: []
    }));
    assert.doesNotThrow(() => new vm.Script(rendered, { filename: 'inventory.handlebars.inline.js' }));
});

test('full Inventory backup downloads and restores only Inventory-owned records', async () => {
    const initial = [
        { _id: 'node//device-1', type: 'node', domain: '', name: 'Mesh node' },
        { _id: 'inventoryasset//asset-1', type: 'inventoryasset', domain: '', name: 'Workstation', assignment: { assignees: [] } },
        { _id: 'inventoryasset//legacy-peripheral', domain: '', assetKind: 'peripheral', name: 'Legacy peripheral' },
        { _id: 'inventoryassetbackup//manual-1', type: 'inventoryassetbackup', domain: '', assetId: 'inventoryasset//manual-1', asset: { _id: 'inventoryasset//manual-1' } },
        { _id: 'inventorysettings/', type: 'inventorysettings', domain: '', mode: 'custom', days: 45 },
        { _id: 'inventorymigration/type-field-v2', type: 'inventorymigration', complete: true }
    ];
    const records = new Map(initial.map((record) => [record._id, JSON.parse(JSON.stringify(record))]));
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAll(callback) { callback(null, Array.from(records.values())); },
        GetAllTypeNoTypeField(type, domain, callback) {
            callback(null, Array.from(records.values()).filter((record) => record.type === type && record.domain === domain));
        },
        Set(record, callback) { records.set(record._id, JSON.parse(JSON.stringify(record))); callback(null); },
        Remove(id, callback) { records.delete(id); callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const invoke = (pluginaction, extra) => new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction(Object.assign({ requestId: pluginaction, pluginaction }, extra || {}), session);
    });

    const exported = await invoke('backup-export');
    assert.equal(exported.ok, true);
    assert.equal(exported.result.kind, 'backup');
    const backup = exported.result.backup;
    assert.equal(backup.format, 'meshcentral-inventory-backup');
    assert.equal(backup.schemaVersion, 1);
    assert.equal(backup.recordCount, 5);
    assert.equal(backup.counts.untyped, 1);
    assert.equal(backup.records.some((record) => record._id === 'node//device-1'), false);

    records.get('inventoryasset//asset-1').name = 'Changed after backup';
    records.delete('inventorysettings/');
    records.set('inventoryasset//added-later', { _id: 'inventoryasset//added-later', type: 'inventoryasset', domain: '', name: 'Added later' });
    const restored = await invoke('backup-restore', { backup, confirm: 'RESTORE INVENTORY' });
    assert.equal(restored.ok, true);
    assert.equal(restored.result.kind, 'backup-restored');
    assert.equal(restored.result.restored, 5);
    assert.equal(restored.result.removed, 1);
    assert.equal(records.get('inventoryasset//asset-1').name, 'Workstation');
    assert.equal(records.get('inventorysettings/').days, 45);
    assert.equal(records.has('inventoryasset//added-later'), false);
    assert.equal(records.get('node//device-1').name, 'Mesh node');
});

test('Inventory restore rejects non-Inventory records before changing the database', async () => {
    const records = new Map([
        ['inventoryasset//safe', { _id: 'inventoryasset//safe', type: 'inventoryasset', domain: '', name: 'Safe' }],
        ['node//device-1', { _id: 'node//device-1', type: 'node', domain: '', name: 'Node' }]
    ]);
    let writes = 0;
    let removals = 0;
    const database = {
        Get() {},
        GetAll(callback) { callback(null, Array.from(records.values())); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, []); },
        Set(record, callback) { writes++; callback(null); },
        Remove(id, callback) { removals++; callback(null); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {},
        getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const badRecords = [{ _id: 'node//injected', type: 'node', domain: '', name: 'Injected' }];
    const backup = {
        format: 'meshcentral-inventory-backup', schemaVersion: 1, pluginVersion: 'test',
        exportedAt: new Date().toISOString(), recordCount: 1,
        checksum: crypto.createHash('sha256').update(JSON.stringify(badRecords)).digest('hex'), records: badRecords
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'unsafe-restore', pluginaction: 'backup-restore', backup, confirm: 'RESTORE INVENTORY' }, session);
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /outside the Inventory namespace/);
    assert.equal(writes, 0);
    assert.equal(removals, 0);
});

test('failed Inventory restore rolls back overwritten and newly added records', async () => {
    const records = new Map([
        ['inventoryasset//safe', { _id: 'inventoryasset//safe', type: 'inventoryasset', domain: '', name: 'Current value' }],
        ['inventoryasset//obsolete', { _id: 'inventoryasset//obsolete', type: 'inventoryasset', domain: '', name: 'Keep after rollback' }],
        ['node//device-1', { _id: 'node//device-1', type: 'node', domain: '', name: 'Node' }]
    ]);
    let failRemoval = true;
    const database = {
        Get() {},
        GetAll(callback) { callback(null, Array.from(records.values())); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, []); },
        Set(record, callback) { records.set(record._id, JSON.parse(JSON.stringify(record))); callback(null); },
        Remove(id, callback) {
            if (id === 'inventoryasset//obsolete' && failRemoval) {
                failRemoval = false;
                callback(new Error('simulated delete failure'));
                return;
            }
            records.delete(id);
            callback(null);
        }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const backupRecords = [
        { _id: 'inventoryasset//safe', type: 'inventoryasset', domain: '', name: 'Backup value' },
        { _id: 'inventoryasset//new', type: 'inventoryasset', domain: '', name: 'New from backup' }
    ];
    const backup = {
        format: 'meshcentral-inventory-backup', schemaVersion: 1, pluginVersion: 'test',
        exportedAt: new Date().toISOString(), recordCount: backupRecords.length,
        checksum: crypto.createHash('sha256').update(JSON.stringify(backupRecords)).digest('hex'), records: backupRecords
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'failed-restore', pluginaction: 'backup-restore', backup, confirm: 'RESTORE INVENTORY' }, session);
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /previous Inventory data was restored/);
    assert.equal(records.get('inventoryasset//safe').name, 'Current value');
    assert.equal(records.get('inventoryasset//obsolete').name, 'Keep after rollback');
    assert.equal(records.has('inventoryasset//new'), false);
    assert.equal(records.get('node//device-1').name, 'Node');
});

test('Inventory backup and restore controls are limited to full administrators', async () => {
    const database = {
        GetAll(callback) { callback(null, []); }, Get() {}, Set() {}, Remove() {},
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, []); }
    };
    const pluginHandler = {
        parent: { db: database, webserver: {}, config: { domains: { '': {} } } },
        registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
    };
    const plugin = require('../inventory').inventory(pluginHandler);
    const session = {
        domain: { id: '' }, user: { _id: 'user//manager', domain: '', siteadmin: 0 },
        ws: { send(message) { session.response(JSON.parse(message)); } }
    };
    const response = await new Promise((resolve) => {
        session.response = resolve;
        plugin.serveraction({ requestId: 'backup-denied', pluginaction: 'backup-export' }, session);
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /full administrator/);
});

test('custom navigation clears all modern and classic selected-state classes', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    assert.match(server, /classList\.remove\('active', 'lbbuttonsel', 'lbbuttonsel2'\)/);
    assert.match(server, /classList\.remove\('style3sel', 'fullselect', 'semiselect'\)/);
});

test('enabled plugin enforces modern UI while preserving modern theme selection', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    const template = fs.readFileSync(path.join(root, 'views', 'inventory.handlebars'), 'utf8');
    assert.match(server, /putstore\('uiViewMode', 3\)/);
    assert.match(server, /searchParams\.set\('sitestyle', '3'\)/);
    assert.match(server, /toggleModernUIMenuItem/);
    assert.match(template, /getElementById\('theme-stylesheet'\)/);
    assert.match(template, /--bs-primary/);
    assert.match(template, /addEventListener\('load', syncTheme\)/);
    assert.match(template, /contrast\(accentCandidates\[candidateIndex\], background\) >= 3/);
});

test('main Inventory navigation clears stale asset detail while refresh restoration preserves it', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    const template = fs.readFileSync(path.join(root, 'views', 'inventory.handlebars'), 'utf8');
    assert.match(server, /openInventory\(true\)/);
    assert.match(server, /preserveDetail !== true/);
    assert.match(server, /searchParams\.delete\('inventoryasset'\)/);
    assert.match(template, /showDashboard: function \(\)/);
});

test('Inventory hides the host My Server submenu and restores its prior layout', () => {
    const previousDocument = global.document;
    function element(options) {
        const attributes = new Map();
        const classes = new Set((options.classes || '').split(/\s+/).filter(Boolean));
        const style = {
            display: options.display || '', priority: '',
            setProperty(name, value, priority) { if (name === 'display') { this.display = value; this.priority = priority || ''; } },
            removeProperty(name) { if (name === 'display') { this.display = ''; this.priority = ''; } },
            getPropertyPriority(name) { return name === 'display' ? this.priority : ''; }
        };
        return {
            style,
            classList: {
                contains(name) { return classes.has(name); },
                remove(name) { classes.delete(name); },
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
            },
            hasAttribute(name) { return attributes.has(name); },
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
            removeAttribute(name) { attributes.delete(name); }
        };
    }
    const submenu = element({ display: 'block' });
    const content = element({ classes: 'room4submenu' });
    try {
        global.document = { getElementById(id) { return id === 'ServerSubMenuSpan' ? submenu : (id === 'column_l' ? content : null); } };
        const pluginHandler = {
            parent: { db: {}, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        plugin.setInventoryHostChrome(true);
        assert.equal(submenu.style.display, 'none');
        assert.equal(submenu.style.priority, 'important');
        assert.equal(content.classList.contains('room4submenu'), false);
        plugin.setInventoryHostChrome(false);
        assert.equal(submenu.style.display, 'block');
        assert.equal(content.classList.contains('room4submenu'), true);
    } finally {
        global.document = previousDocument;
    }
});

test('returning to Inventory reuses its loaded iframe instead of reloading it', () => {
    const previousWindow = global.window;
    const previousDocument = global.document;
    const previousUrlargs = global.urlargs;
    const previousGo = global.go;
    const previousGoPlugin = global.goPlugin;
    let dashboardCalls = 0;
    let goCalls = 0;
    let pluginLoads = 0;
    const location = { href: 'https://mesh.example/?viewmode=3' };
    const frame = {
        getAttribute(name) { return name === 'src' ? '/pluginadmin.ashx?pin=inventory' : null; },
        contentWindow: { InventoryApp: { showDashboard() { dashboardCalls++; } } }
    };
    try {
        global.window = {
            location,
            history: { replaceState(_state, _title, nextUrl) { location.href = new URL(nextUrl, location.href).href; } }
        };
        global.document = { title: 'MeshCentral', getElementById(id) { return id === 'p43iframe' ? frame : null; } };
        global.urlargs = { viewmode: '3' };
        global.go = function (page) { if (page === 43) goCalls++; };
        global.goPlugin = function () { pluginLoads++; };
        const pluginHandler = {
            parent: { db: {}, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        pluginHandler.inventory = plugin;
        plugin.setInventoryUrlMarker = function () {};
        plugin.setInventoryHostChrome = function () {};
        plugin.fitInventoryFrame = function () {};
        plugin.setInventoryHeading = function () {};
        plugin.setInventorySelected = function () {};
        plugin.openInventory(false);
        assert.equal(dashboardCalls, 1);
        assert.equal(goCalls, 1);
        assert.equal(pluginLoads, 0);
    } finally {
        global.window = previousWindow;
        global.document = previousDocument;
        global.urlargs = previousUrlargs;
        if (previousGo === undefined) delete global.go; else global.go = previousGo;
        if (previousGoPlugin === undefined) delete global.goPlugin; else global.goPlugin = previousGoPlugin;
    }
});

test('leaving Inventory removes its route without changing the MeshCentral device route', () => {
    const previousWindow = global.window;
    const previousDocument = global.document;
    const previousUrlargs = global.urlargs;
    const startingUrl = 'https://mesh.example/?viewmode=11&gotonode=device-1&inventoryplugin=1&inventorytab=workstations&inventoryasset=asset-1';
    const location = { href: startingUrl };
    global.window = {
        location,
        history: {
            replaceState(_state, _title, nextUrl) { location.href = new URL(nextUrl, location.href).href; }
        }
    };
    global.document = { title: 'MeshCentral', getElementById() { return null; } };
    global.urlargs = {
        viewmode: '11', gotonode: 'device-1', inventoryplugin: '1',
        inventorytab: 'workstations', inventoryasset: 'asset-1'
    };
    try {
        const pluginHandler = {
            parent: { db: {}, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        plugin.setInventoryUrlMarker(false);
        const url = new URL(location.href);
        assert.equal(url.searchParams.get('viewmode'), '11');
        assert.equal(url.searchParams.get('gotonode'), 'device-1');
        for (const key of ['inventoryplugin', 'inventorytab', 'inventoryasset']) {
            assert.equal(url.searchParams.has(key), false);
            assert.equal(Object.hasOwn(global.urlargs, key), false);
        }
    } finally {
        global.window = previousWindow;
        global.document = previousDocument;
        global.urlargs = previousUrlargs;
    }
});

test('leaving Inventory refreshes the host My Devices panel after navigation completes', () => {
    const previousWindow = global.window;
    const previousDocument = global.document;
    const previousCurrentView = global.xxcurrentView;
    const previousAdjustPanels = global.adjustPanels;
    const previousOnDevicesScrollEx = global.onDevicesScrollEx;
    let panelRefreshes = 0;
    let deviceRefreshes = 0;
    try {
        global.window = { setTimeout(callback) { callback(); } };
        global.document = { getElementById() { return null; }, querySelector() { return null; } };
        global.xxcurrentView = 43;
        global.adjustPanels = function () { panelRefreshes++; };
        global.onDevicesScrollEx = function () { deviceRefreshes++; };
        const pluginHandler = {
            parent: { db: {}, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        pluginHandler.inventory = plugin;
        plugin.fitInventoryFrame = function () {};
        plugin.setInventoryUrlMarker = function () {};
        plugin.setInventoryHeading = function () {};
        plugin.setInventorySelected = function () {};
        plugin.goPageStart(1);
        assert.equal(panelRefreshes, 1);
        assert.equal(deviceRefreshes, 1);
    } finally {
        global.window = previousWindow;
        global.document = previousDocument;
        if (previousCurrentView === undefined) delete global.xxcurrentView;
        else global.xxcurrentView = previousCurrentView;
        if (previousAdjustPanels === undefined) delete global.adjustPanels;
        else global.adjustPanels = previousAdjustPanels;
        if (previousOnDevicesScrollEx === undefined) delete global.onDevicesScrollEx;
        else global.onDevicesScrollEx = previousOnDevicesScrollEx;
    }
});

test('dashboard and per-device iframes only consume their own responses', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    const template = fs.readFileSync(path.join(root, 'views', 'inventory.handlebars'), 'utf8');
    assert.match(template, /frameRequestPrefix/);
    assert.match(template, /pendingRequests\[message\.requestId\]/);
    assert.match(template, /return false;/);
    assert.match(template, /delete state\.pendingRequests\[sentRequestId\]/);
    assert.match(server, /InventoryApp\.receive\(message\) === true/);
    assert.match(server, /data-inventory-nodeid/);
    assert.match(server, /!== nodeid/);
});

test('shared plugin page restores Inventory safely and clears its state for another plugin', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    assert.match(server, /params\.has\('inventorytab'\)/);
    assert.match(server, /params\.has\('inventoryasset'\)/);
    assert.match(server, /data-inventory-frame-watch/);
    assert.match(server, /source\.indexOf\('pin=inventory'\) < 0/);
    assert.match(server, /delete urlargs\.inventoryasset/);
    assert.match(server, /delete urlargs\.inventorytab/);
    assert.match(server, /delete urlargs\.sitestyle/);
    const template = fs.readFileSync(path.join(root, 'views', 'inventory.handlebars'), 'utf8');
    assert.match(template, /window\.parent\.urlargs\.inventoryasset/);
    assert.match(template, /window\.parent\.urlargs\.inventorytab/);
});

test('Inventory owns the remaining viewport without nested page scrolling', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
    const template = fs.readFileSync(path.join(root, 'views', 'inventory.handlebars'), 'utf8');
    assert.match(server, /fitInventoryFrame\(true\)/);
    assert.match(server, /fitInventoryFrame\(false\)/);
    assert.match(server, /window\.innerHeight - Math\.max\(0, top\)/);
    assert.match(server, /data-inventory-original-height/);
    assert.match(template, /html, body \{ height: 100%; min-height: 0; overflow: hidden; \}/);
    assert.match(template, /\.inv-table-wrap \{[\s\S]*?overflow: auto; overscroll-behavior: contain;/);
    assert.match(template, /\.inv-detail\.open \{[\s\S]*?height: 100%; overflow: auto;/);
    assert.doesNotMatch(template, /max-width: 1800px/);
});

test('Inventory frame fitting fills the viewport and restores the shared plugin frame', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;
    const attributes = new Map();
    const frame = {
        style: { height: 'calc(100vh - 245px)', maxHeight: 'calc(100vh - 245px)' },
        hasAttribute(name) { return attributes.has(name); },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        removeAttribute(name) { attributes.delete(name); },
        getBoundingClientRect() { return { top: 300 }; }
    };
    try {
        global.window = { innerHeight: 900 };
        global.document = { getElementById(id) { return id === 'p43iframe' ? frame : null; } };
        const pluginHandler = {
            parent: { db: { Get() {}, Set() {}, Remove() {}, GetAllTypeNoTypeField() {} }, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        pluginHandler.inventory = plugin;
        plugin.fitInventoryFrame(true);
        assert.equal(frame.style.height, '600px');
        assert.equal(frame.style.maxHeight, '600px');
        plugin.fitInventoryFrame(false);
        assert.equal(frame.style.height, 'calc(100vh - 245px)');
        assert.equal(frame.style.maxHeight, 'calc(100vh - 245px)');
        assert.equal(attributes.has('data-inventory-original-height'), false);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('Inventory refits the shared plugin frame after MeshCentral rewrites its style', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;
    const originalMutationObserver = global.MutationObserver;
    const originalCurrentView = global.xxcurrentView;
    const attributes = new Map();
    let observedOptions = null;
    let observerCallback = null;
    const frame = {
        style: { height: 'calc(100vh - 245px)', maxHeight: 'calc(100vh - 245px)' },
        hasAttribute(name) { return attributes.has(name); },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) {
            if (name === 'src') return '/pluginadmin.ashx?pin=inventory';
            return attributes.has(name) ? attributes.get(name) : null;
        },
        removeAttribute(name) { attributes.delete(name); },
        getBoundingClientRect() { return { top: 300 }; }
    };
    try {
        global.window = {
            innerHeight: 900,
            addEventListener() {},
            setTimeout(callback) { callback(); }
        };
        global.xxcurrentView = 43;
        global.document = { getElementById(id) { return id === 'p43iframe' ? frame : null; } };
        global.MutationObserver = class MutationObserver {
            constructor(callback) { observerCallback = callback; }
            observe(_target, options) { observedOptions = options; }
        };
        const pluginHandler = {
            parent: { db: { Get() {}, Set() {}, Remove() {}, GetAllTypeNoTypeField() {} }, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        pluginHandler.inventory = plugin;
        plugin.trackPluginFrame();
        assert.deepEqual(observedOptions.attributeFilter, ['src', 'style']);

        frame.style.height = 'calc(100vh - 245px)';
        frame.style.maxHeight = 'calc(100vh - 245px)';
        observerCallback([{ type: 'attributes', attributeName: 'style', target: frame }]);
        assert.equal(frame.style.height, '600px');
        assert.equal(frame.style.maxHeight, '600px');
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
        global.MutationObserver = originalMutationObserver;
        if (originalCurrentView === undefined) delete global.xxcurrentView;
        else global.xxcurrentView = originalCurrentView;
    }
});

test('Inventory frame watcher stays inactive while My Devices owns the page', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;
    const originalMutationObserver = global.MutationObserver;
    const originalCurrentView = global.xxcurrentView;
    let observerCallback = null;
    const attributes = new Map();
    const frame = {
        style: { height: 'calc(100vh - 245px)', maxHeight: 'calc(100vh - 245px)' },
        hasAttribute(name) { return attributes.has(name); },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) {
            if (name === 'src') return '/pluginadmin.ashx?pin=inventory';
            return attributes.has(name) ? attributes.get(name) : null;
        },
        getBoundingClientRect() { return { top: 300 }; }
    };
    try {
        global.window = {
            innerHeight: 900,
            addEventListener() {},
            setTimeout(callback) { callback(); }
        };
        global.xxcurrentView = 1;
        global.document = { getElementById(id) { return id === 'p43iframe' ? frame : null; } };
        global.MutationObserver = class MutationObserver {
            constructor(callback) { observerCallback = callback; }
            observe() {}
        };
        const pluginHandler = {
            parent: { db: { Get() {}, Set() {}, Remove() {}, GetAllTypeNoTypeField() {} }, webserver: {}, config: { domains: { '': {} } } },
            registerPermissions() {}, getAccessPermissions() { return Promise.resolve(() => true); }
        };
        const plugin = require('../inventory').inventory(pluginHandler);
        pluginHandler.inventory = plugin;
        plugin.trackPluginFrame();
        observerCallback([{ type: 'attributes', attributeName: 'style', target: frame }]);
        assert.equal(frame.style.height, 'calc(100vh - 245px)');
        assert.equal(frame.style.maxHeight, 'calc(100vh - 245px)');
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
        global.MutationObserver = originalMutationObserver;
        if (originalCurrentView === undefined) delete global.xxcurrentView;
        else global.xxcurrentView = originalCurrentView;
    }
});

test('plugin package contains no software-inventory collector', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8').toLowerCase();
    const model = fs.readFileSync(path.join(root, 'lib', 'model.js'), 'utf8').toLowerCase();
    assert.equal(server.includes('installedapps'), false);
    assert.equal(model.includes('installedapps'), false);
});
