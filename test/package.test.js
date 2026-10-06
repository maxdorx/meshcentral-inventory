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
        _id: 'node//device-1', domain: '', meshid: 'mesh//group-1', name: 'DAX-LAP-042',
        osdesc: 'Windows 11', users: ['DAX\\basith'], agent: { id: 4, ver: 125 }
    };
    const sysinfo = {
        _id: 'sinode//device-1', domain: '', type: 'sysinfo', time: Date.now(),
        hardware: { identifiers: { chassis_serial: 'SERIAL-042', product_uuid: '2e1efb37-4707-4a5f-861f-fbb8c30dc001' } }
    };
    const database = {
        Get(id, callback) {
            if (id === node._id) return callback(null, [node]);
            if (id === `si${node._id}`) return callback(null, [sysinfo]);
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
            webserver: { meshes: { 'mesh//group-1': { name: 'DAX/MINERVA' } }, wsagents: {} },
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
    assert.equal(savedAsset.name, 'DAX-LAP-042');
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
        nodeids: ['node//device-1'], meshid: 'mesh//group-1', name: 'DAX-LAP-001',
        identity: { serial: 'PC-001', uuid: '11111111-1111-4111-8111-111111111111' },
        automatic: { nodeExists: true }, manual: { assetTag: 'PC-TAG-001' },
        assignment: { mode: 'unassigned', assignees: [], pending: [] }
    };
    const records = new Map([[workstation._id, workstation]]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? Array.from(records.values()) : []); },
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
        assigned_user: 'reception@example.com', linked_workstation: 'DAX-LAP-001', status: 'Assigned'
    } });
    assert.equal(createdResponse.ok, true);
    const created = createdResponse.result.assets[0];
    assert.equal(created.assetKind, 'peripheral');
    assert.equal(created.links.workstationAssetId, workstation._id);
    assert.equal(created.assignment.assignees[0].id, 'reception@example.com');

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
});

test('agent synchronization never merges a workstation into a manual peripheral with the same serial', async () => {
    const node = { _id: 'node//device-2', domain: '', meshid: 'mesh//group-1', name: 'DAX-LAP-002', users: [], agent: { id: 4, ver: 125 } };
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
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? Array.from(records.values()) : []); },
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
    assert.equal(records.size, 2);
    assert.equal(records.get(peripheral._id).nodeid, '');
    const workstation = Array.from(records.values()).find((asset) => asset.assetKind !== 'peripheral');
    assert.equal(workstation.nodeid, node._id);
    assert.equal(workstation.identity.serial, 'SHARED-SERIAL');
});

test('manual workstation creation blocks identifiers already used by automatic inventory', async () => {
    const automatic = {
        _id: 'inventoryasset//automatic-1', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        name: 'DAX-LAP-010', identity: { serial: 'SERIAL-010', uuid: '10101010-1010-4010-8010-101010101010' },
        nodeid: 'node//device-10', nodeids: ['node//device-10'], meshid: 'mesh//group-1',
        automatic: { assetTagReported: 'TAG-010', nodeExists: true }, manual: { assetTag: '' },
        assignment: { mode: 'unassigned', assignees: [], pending: [] }, history: []
    };
    const records = new Map([[automatic._id, automatic]]);
    const database = {
        Get(id, callback) { callback(null, records.has(id) ? [records.get(id)] : []); },
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? Array.from(records.values()) : []); },
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
    assert.match(response.error, /Serial number already belongs to DAX-LAP-010/);
    response = await invoke({ pluginaction: 'workstation-create', workstation: {
        name: 'Spare laptop', serial: 'MANUAL-011', uuid: '11111111-2222-4333-8444-555555555555', asset_tag: 'TAG-011'
    } });
    assert.equal(response.ok, true);
    assert.equal(response.result.kind, 'workstation-created');
    assert.equal(response.result.asset.source, 'manual');
    assert.equal(response.result.asset.nodeid, '');
    assert.equal(records.size, 2);
});

test('an agent never merges into a manual workstation and both records receive a duplicate warning', async () => {
    const node = { _id: 'node//device-20', domain: '', meshid: 'mesh//group-1', name: 'DAX-LAP-020', users: [], agent: { id: 4, ver: 126 } };
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
        GetAllTypeNoTypeField(type, domain, callback) { callback(null, type === 'inventoryasset' ? Array.from(records.values()) : []); },
        Set(document, callback) {
            records.set(document._id, JSON.parse(JSON.stringify(document)));
            callback(null);
            const values = Array.from(records.values());
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
    assert.equal(records.size, 2);
    assert.equal(records.get(manual._id).nodeid, '');
    const automatic = Array.from(records.values()).find((asset) => asset.source === 'automatic');
    assert.ok(automatic);
    assert.equal(automatic.nodeid, node._id);
    assert.equal(automatic.duplicateConflicts[0].otherAssetId, manual._id);
    assert.equal(records.get(manual._id).duplicateConflicts[0].otherAssetId, automatic._id);
});

test('inventory list is read-only and only returns assets in the users accessible device groups', async () => {
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
    assert.deepEqual(response.result.assets.map((asset) => asset.name), ['VISIBLE-MOUSE', 'VISIBLE-PC']);
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
                return callback(null, [existingWorkstation, linkedPeripheral]);
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
    assert.equal(savedPeripheral.scope.meshid, 'mesh//group-1');
    assert.equal(savedPeripheral.links.workstationMeshId, 'mesh//group-1');
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

test('device-group removal policy drives stale review and settings remain admin-only', async () => {
    const now = Date.now();
    const node = { _id: 'node//policy', type: 'node', domain: '', meshid: 'mesh//policy', name: 'POLICY-PC', agent: { id: 4 } };
    const asset = {
        _id: 'inventoryasset//policy', type: 'inventoryasset', domain: '', assetKind: 'workstation', source: 'automatic',
        nodeid: node._id, nodeids: [node._id], meshid: node.meshid, name: node.name, status: 'Available',
        identity: { serial: 'POLICY-SERIAL', uuid: '' }, automatic: { lastSeen: now - 11 * 86400000, nodeExists: true, online: false },
        manual: {}, assignment: { mode: 'unassigned', assignees: [], pending: [], initialized: true }, history: []
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
    response = await invoke('settings-update', { settings: { mode: 'custom', days: 12 } });
    assert.equal(response.ok, true);
    assert.match(response.result.settingsWarning, /may disappear/);
    assert.equal(records.get('inventorysettings/').days, 12);
    assert.deepEqual(records.get(asset._id).reviews, []);
    session.user = { _id: 'user//scoped', domain: '', siteadmin: 0 };
    response = await invoke('settings-update', { settings: { mode: 'disabled', days: 30 } });
    assert.equal(response.ok, false);
    assert.match(response.error, /full administrator/);
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
    assert.match(server, /openInventory\(true\)/);
    assert.match(server, /preserveDetail !== true/);
    assert.match(server, /searchParams\.delete\('inventoryasset'\)/);
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

test('plugin package contains no software-inventory collector', () => {
    const server = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8').toLowerCase();
    const model = fs.readFileSync(path.join(root, 'lib', 'model.js'), 'utf8').toLowerCase();
    assert.equal(server.includes('installedapps'), false);
    assert.equal(model.includes('installedapps'), false);
});
