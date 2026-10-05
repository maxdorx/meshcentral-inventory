'use strict';

module.exports.inventory = function inventoryPlugin(pluginHandler) {
    const crypto = require('crypto');
    const model = require('./lib/model');
    const plugin = {};
    const root = pluginHandler.parent;
    const db = root.db;
    const queues = new Map();
    const lastDomainScan = new Map();
    const SCAN_TTL_MS = 5 * 60 * 1000;

    let permissionsRegistered = false;
    function registerPermissions() {
        if (permissionsRegistered || typeof pluginHandler.registerPermissions !== 'function') return;
        pluginHandler.registerPermissions('inventory', {
            can_view: {
                title: 'View inventory',
                desc: 'View lifecycle and assignment records for accessible devices.',
                default: 'allowed'
            },
            can_manage: {
                title: 'Manage inventory',
                desc: 'Change lifecycle, manual fields, assignments, and review decisions.',
                default: 'denied'
            },
            can_sync: {
                title: 'Synchronize inventory',
                desc: 'Run a full synchronization from MeshCentral device and agent details.',
                default: 'denied'
            }
        });
        permissionsRegistered = true;
    }
    registerPermissions();

    function log(message, error) {
        const suffix = error ? `: ${error.stack || error.message || error}` : '';
        console.log(`[inventory] ${message}${suffix}`);
    }

    function webServer() {
        return root.webserver;
    }

    function dbGet(id) {
        return new Promise((resolve, reject) => {
            db.Get(id, (error, docs) => {
                if (error) return reject(error);
                resolve(Array.isArray(docs) && docs.length > 0 ? docs[0] : null);
            });
        });
    }

    function dbAll(type, domain) {
        return new Promise((resolve, reject) => {
            db.GetAllTypeNoTypeField(type, domain, (error, docs) => {
                if (error) return reject(error);
                resolve(Array.isArray(docs) ? docs : []);
            });
        });
    }

    function dbSet(document) {
        return new Promise((resolve, reject) => {
            db.Set(document, (error) => error ? reject(error) : resolve(document));
        });
    }

    function dbRemove(id) {
        return new Promise((resolve, reject) => {
            db.Remove(id, (error) => error ? reject(error) : resolve());
        });
    }

    function withQueue(key, work) {
        const previous = queues.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(work);
        queues.set(key, current);
        return current.finally(() => {
            if (queues.get(key) === current) queues.delete(key);
        });
    }

    function assetId(domain, seed) {
        const hash = crypto.createHash('sha256').update(`${domain}\n${seed}`).digest('hex').substring(0, 32);
        return `inventoryasset/${domain}/${hash}`;
    }

    function isPeripheral(asset) {
        return Boolean(asset && asset.assetKind === 'peripheral');
    }

    function isWorkstation(asset) {
        return !isPeripheral(asset);
    }

    function isManualWorkstation(asset) {
        return isWorkstation(asset) && asset && asset.source === 'manual';
    }

    function workstationIdentifiers(asset) {
        return {
            serial: model.normalizeSerial(asset && asset.identity && asset.identity.serial),
            uuid: model.normalizeUuid(asset && asset.identity && asset.identity.uuid),
            assetTag: normalizedKey(asset && asset.manual && asset.manual.assetTag)
                || normalizedKey(asset && asset.automatic && asset.automatic.assetTagReported)
        };
    }

    function duplicateKey(conflict) {
        return JSON.stringify({
            kind: conflict.kind,
            otherAssetId: conflict.otherAssetId,
            matches: (conflict.matches || []).slice().sort()
        });
    }

    async function reconcileCrossSourceDuplicates(domain, suppliedAssets, actor, now) {
        const assets = suppliedAssets || await dbAll('inventoryasset', domain);
        const workstations = assets.filter(isWorkstation);
        const manual = workstations.filter(isManualWorkstation);
        const automatic = workstations.filter((asset) => !isManualWorkstation(asset));
        const desired = new Map(workstations.map((asset) => [asset._id, []]));

        for (const manualAsset of manual) {
            const left = workstationIdentifiers(manualAsset);
            for (const automaticAsset of automatic) {
                const right = workstationIdentifiers(automaticAsset);
                const matches = [];
                if (left.uuid && right.uuid && left.uuid === right.uuid) matches.push('UUID');
                if (left.serial && right.serial && left.serial === right.serial) matches.push('serial');
                if (left.assetTag && right.assetTag && left.assetTag === right.assetTag) matches.push('asset tag');
                if (matches.length === 0) continue;
                desired.get(manualAsset._id).push({
                    kind: 'cross-source-duplicate',
                    otherAssetId: automaticAsset._id,
                    otherName: automaticAsset.name || automaticAsset._id,
                    otherSource: 'automatic',
                    matches
                });
                desired.get(automaticAsset._id).push({
                    kind: 'cross-source-duplicate',
                    otherAssetId: manualAsset._id,
                    otherName: manualAsset.name || manualAsset._id,
                    otherSource: 'manual',
                    matches
                });
            }
        }

        for (const asset of workstations) {
            const next = desired.get(asset._id) || [];
            next.sort((a, b) => duplicateKey(a).localeCompare(duplicateKey(b)));
            const previous = Array.isArray(asset.duplicateConflicts) ? asset.duplicateConflicts : [];
            const previousKeys = previous.map(duplicateKey).sort();
            const nextKeys = next.map(duplicateKey);
            if (JSON.stringify(previousKeys) === JSON.stringify(nextKeys)) continue;
            asset.duplicateConflicts = next;
            asset.updatedAt = now;
            if (next.length > previous.length) {
                model.addHistory(asset, 'workstation.duplicate-detected', actor || 'system', `Potential duplicate workstation record: ${next.map((item) => `${item.otherName} (${item.matches.join(', ')})`).join('; ')}`, now);
            } else if (next.length === 0 && previous.length > 0) {
                model.addHistory(asset, 'workstation.duplicate-cleared', actor || 'system', 'Cross-source duplicate warning cleared.', now);
            }
            await dbSet(asset);
        }
    }

    function availableAssetId(domain, seed, nodeid, assets) {
        const occupied = new Set((assets || []).map((item) => item && item._id).filter(Boolean));
        let id = assetId(domain, seed);
        if (!occupied.has(id)) return id;

        // Old inventory records may have an ID derived from a UUID that was
        // later replaced by another reported UUID. Never overwrite that record
        // when the original UUID is seen again; allocate a stable alternate ID.
        let suffix = 0;
        do {
            const discriminator = suffix === 0 ? nodeid : `${nodeid}\n${suffix}`;
            id = assetId(domain, `${seed}\n${discriminator}`);
            suffix++;
        } while (occupied.has(id));
        return id;
    }

    function meshName(meshid) {
        const server = webServer();
        return server && server.meshes && server.meshes[meshid] ? server.meshes[meshid].name : '';
    }

    function isOnline(nodeid) {
        const server = webServer();
        return Boolean(server && server.wsagents && server.wsagents[nodeid]);
    }

    async function syncNode(node, suppliedSysinfo, source, authoritativeUsers, suppliedLastConnectTime, deferDuplicateReconcile) {
        // The default MeshCentral domain is the valid empty string.
        if (!node || !node._id || node.domain === null || node.domain === undefined) return null;
        // One queue per domain makes the read-match-create sequence atomic inside
        // this MeshCentral process. This prevents two agents with the same
        // serial/UUID from creating duplicate inventory records concurrently.
        return withQueue(`domain:${node.domain}`, async () => {
            const domain = node.domain;
            const assets = await dbAll('inventoryasset', domain);
            // Manual workstations are a separate inventory source. An agent may
            // never adopt, merge into, or overwrite one of those records.
            const workstations = assets.filter((item) => isWorkstation(item) && !isManualWorkstation(item));
            let sysinfo = suppliedSysinfo;
            if (!sysinfo) sysinfo = await dbGet(`si${node._id}`);

            const snapshot = model.snapshotFrom(node, sysinfo, meshName(node.meshid), isOnline(node._id), suppliedLastConnectTime);
            if (typeof authoritativeUsers === 'boolean') snapshot.userReportAuthoritative = authoritativeUsers;
            let asset = workstations.find((item) => item.nodeid === node._id || (Array.isArray(item.nodeids) && item.nodeids.includes(node._id)));
            let conflicts = [];

            // Repair legacy false merges caused by firmware placeholder serials.
            // A multi-node asset whose linked node now disagrees on both valid
            // serial and UUID represents different physical hardware. Detach
            // this node and allow the normal identity selector to create/link
            // the correct asset.
            if (asset && Array.isArray(asset.nodeids) && asset.nodeids.length > 1) {
                const storedSerial = model.normalizeSerial(asset.identity && asset.identity.serial);
                const storedUuid = model.normalizeUuid(asset.identity && asset.identity.uuid);
                const legacyPlaceholderMerge = Boolean(asset.identity && asset.identity.serial && !storedSerial);
                if (legacyPlaceholderMerge && !asset.identityMergeRepairAt) {
                    if (!asset.assignment) asset.assignment = {};
                    asset.assignment.pending = [];
                    asset.assignment.resolutions = [];
                    asset.assignment.ignored = [];
                    asset.observedUsers = [];
                    asset.identityConflicts = [];
                    asset.identityResolutions = [];
                    delete asset._lastIdentityConflict;
                    asset.identityMergeRepairAt = Date.now();
                    model.addHistory(asset, 'identity.merge-repaired', 'synchronizer', `Started repair of ${asset.nodeids.length} nodes merged by firmware placeholder serial ${asset.identity.serial}. Pending user reviews were cleared; the primary assignee was retained.`, asset.identityMergeRepairAt);
                }
                const uuidComparable = Boolean(snapshot.uuid && storedUuid);
                const differentHardware = uuidComparable
                    ? snapshot.uuid !== storedUuid
                    : Boolean(snapshot.serial && snapshot.serial !== storedSerial);
                if (differentHardware) {
                    asset.nodeids = asset.nodeids.filter((nodeid) => nodeid !== node._id);
                    if (asset.nodeid === node._id) asset.nodeid = asset.nodeids[0] || '';
                    asset.updatedAt = Date.now();
                    model.addHistory(asset, 'node.unlinked', 'synchronizer', `Unlinked ${node._id} while repairing a legacy placeholder-serial merge.`, asset.updatedAt);
                    await dbSet(asset);
                    asset = null;
                }
            }

            if (!asset) {
                const selection = model.selectAsset(workstations, snapshot);
                asset = selection.asset;
                conflicts = selection.conflicts;
            }

            const now = Date.now();
            if (!asset) {
                const seed = snapshot.uuid || snapshot.serial || snapshot.nodeid;
                asset = model.createAsset(availableAssetId(domain, seed, snapshot.nodeid, assets), domain, snapshot, now);
            }

            asset.type = 'inventoryasset';
            asset.domain = domain;
            model.applySnapshot(asset, snapshot, now, source || 'system', conflicts);
            await dbSet(asset);
            if (deferDuplicateReconcile !== true) {
                const currentAssets = assets.filter((item) => item._id !== asset._id).concat([asset]);
                await reconcileCrossSourceDuplicates(domain, currentAssets, source || 'system', now);
            }
            return asset;
        });
    }

    async function scanDomain(domain, force) {
        const now = Date.now();
        if (!force && lastDomainScan.has(domain) && (now - lastDomainScan.get(domain)) < SCAN_TTL_MS) return;
        lastDomainScan.set(domain, now);

        const nodes = await dbAll('node', domain);
        const sysinfos = await dbAll('sysinfo', domain);
        const lastConnects = await dbAll('lastconnect', domain);
        const sysinfoByNode = new Map();
        for (const sysinfo of sysinfos) {
            if (typeof sysinfo._id === 'string' && sysinfo._id.startsWith('sinode/')) {
                sysinfoByNode.set(sysinfo._id.substring(2), sysinfo);
            }
        }
        const lastConnectByNode = new Map();
        for (const record of lastConnects) {
            if (typeof record._id === 'string' && record._id.startsWith('lcnode/')) {
                lastConnectByNode.set(record._id.substring(2), Number(record.time) || null);
            }
        }

        for (const node of nodes) {
            if (!node || node.deleted === true || !node._id) continue;
            await syncNode(node, sysinfoByNode.get(node._id), 'synchronizer', false, lastConnectByNode.get(node._id), true);
        }

        const activeNodeIds = new Set(nodes.filter((node) => node && !node.deleted).map((node) => node._id));
        const assets = await dbAll('inventoryasset', domain);
        for (const asset of assets) {
            if (isPeripheral(asset) || isManualWorkstation(asset)) continue;
            const linked = (asset.nodeids || []).some((nodeid) => activeNodeIds.has(nodeid));
            if (!linked && asset.automatic && (asset.automatic.online !== false || asset.automatic.nodeExists !== false)) {
                asset.type = 'inventoryasset';
                asset.domain = domain;
                asset.automatic.online = false;
                asset.automatic.nodeExists = false;
                asset.updatedAt = now;
                model.addHistory(asset, 'node.missing', 'synchronizer', 'MeshCentral node is no longer present; inventory retained.', now);
                await dbSet(asset);
            } else if (linked && asset.automatic) {
                asset.type = 'inventoryasset';
                asset.domain = domain;
                asset.automatic.nodeExists = true;
                await dbSet(asset);
            }
        }
        await reconcileCrossSourceDuplicates(domain, null, 'synchronizer', now);
    }

    function safeJson(value) {
        return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    }

    async function permissions(user, context) {
        if (!user) return () => false;
        return pluginHandler.getAccessPermissions('inventory', user, context || {});
    }

    function visibleToUser(asset, user) {
        if (!asset || !user || asset.domain !== user.domain) return false;
        if (user.siteadmin === 0xFFFFFFFF) return true;
        if (isPeripheral(asset)) return true;
        const server = webServer();
        if (!server || typeof server.GetAllMeshIdWithRights !== 'function') return false;
        return server.GetAllMeshIdWithRights(user).includes(asset.meshid);
    }

    function publicAsset(asset, includeHistory) {
        const result = {
            id: asset._id,
            nodeid: asset.nodeid || '',
            nodeids: asset.nodeids || [],
            meshid: asset.meshid || '',
            meshName: asset.meshName || '',
            name: asset.name || '',
            assetKind: isPeripheral(asset) ? 'peripheral' : 'workstation',
            source: asset.source || (isPeripheral(asset) ? 'manual' : 'automatic'),
            status: asset.status || 'Discovered',
            identity: asset.identity || {},
            automatic: asset.automatic || {},
            manualHardware: asset.manualHardware || {},
            manual: asset.manual || {},
            peripheral: asset.peripheral || {},
            links: asset.links || {},
            assignment: asset.assignment || { mode: 'unassigned', assignees: [], pending: [] },
            observedUsers: asset.observedUsers || [],
            identityConflicts: asset.identityConflicts || [],
            duplicateConflicts: asset.duplicateConflicts || [],
            identityResolutions: asset.identityResolutions || [],
            createdAt: asset.createdAt || null,
            updatedAt: asset.updatedAt || null
        };
        if (includeHistory) result.history = asset.history || [];
        return result;
    }

    function summary(assets) {
        const result = { total: assets.length, assigned: 0, available: 0, review: 0, repair: 0, retired: 0 };
        for (const asset of assets) {
            if (asset.status === 'Assigned') result.assigned++;
            if (asset.status === 'Available' || asset.status === 'Discovered') result.available++;
            if (asset.status === 'In Repair') result.repair++;
            if (asset.status === 'Retired') result.retired++;
            if ((asset.assignment.pending || []).length > 0 || (asset.identityConflicts || []).length > 0 || (asset.duplicateConflicts || []).length > 0) result.review++;
        }
        return result;
    }

    function send(session, requestId, ok, result, error) {
        try {
            session.ws.send(JSON.stringify({
                action: 'plugin',
                plugin: 'inventory',
                method: 'receiveInventoryMessage',
                requestId: requestId || null,
                ok: ok,
                result: result || null,
                error: error || null
            }));
        } catch (sendError) {
            log('Unable to send browser response', sendError);
        }
    }

    async function requireAsset(command, session, permissionName) {
        const id = model.text(command.assetId, 256);
        if (!id.startsWith(`inventoryasset/${session.domain.id}/`)) throw new Error('Invalid asset identifier.');
        const asset = await dbGet(id);
        if (!asset || !visibleToUser(asset, session.user)) throw new Error('Asset not found or not accessible.');
        // MeshCentral 1.2.6 attempts to resolve a supplied node id when no mesh id
        // accompanies it. A retained/manual record may not have a live node, and
        // that resolver assumes the database returned at least one row. Only use
        // node-scoped permissions when the complete scope is available; visibility
        // was already checked above for non-administrators.
        const permissionContext = (!isPeripheral(asset) && asset.nodeid && asset.meshid)
            ? { nodeid: asset.nodeid, meshid: asset.meshid }
            : {};
        const check = await permissions(session.user, permissionContext);
        if (!check(permissionName)) throw new Error('Permission denied.');
        return asset;
    }

    function normalizedKey(value) {
        return model.text(value, 256).toLowerCase();
    }

    function resolveWorkstation(reference, workstations) {
        const requested = normalizedKey(reference);
        if (!requested) return { asset: null, error: '' };
        const matches = (workstations || []).filter((asset) => {
            const candidates = [
                asset._id, asset.nodeid, asset.name,
                asset.manual && asset.manual.assetTag,
                asset.identity && asset.identity.serial
            ].map(normalizedKey).filter(Boolean);
            return candidates.includes(requested);
        });
        if (matches.length === 0) return { asset: null, error: `Linked workstation "${reference}" was not found.` };
        if (matches.length > 1) return { asset: null, error: `Linked workstation "${reference}" is ambiguous; use its exact serial number.` };
        return { asset: matches[0], error: '' };
    }

    function preparePeripheralRows(rows, assets, excludedAssetId) {
        if (!Array.isArray(rows)) throw new Error('Peripheral rows are required.');
        if (rows.length === 0) throw new Error('No peripheral rows were provided.');
        if (rows.length > 500) throw new Error('A maximum of 500 peripherals can be imported at once.');
        const peripherals = assets.filter((asset) => isPeripheral(asset) && asset._id !== excludedAssetId);
        const workstations = assets.filter(isWorkstation);
        const serialOwners = new Map();
        const tagOwners = new Map();
        for (const asset of peripherals) {
            const serial = model.normalizeSerial(asset.identity && asset.identity.serial);
            const tag = normalizedKey(asset.manual && asset.manual.assetTag);
            if (serial) serialOwners.set(serial, asset.name || asset._id);
            if (tag) tagOwners.set(tag, asset.name || asset._id);
        }
        return rows.map((row, index) => {
            const rowNumber = Number(row && row.rowNumber) || index + 2;
            const parsed = model.peripheralInput(row);
            const errors = parsed.errors.slice();
            const value = parsed.value;
            if (value.serial) {
                if (serialOwners.has(value.serial)) errors.push(`Serial number already belongs to ${serialOwners.get(value.serial)}.`);
                else serialOwners.set(value.serial, `CSV row ${rowNumber}`);
            }
            const tag = normalizedKey(value.assetTag);
            if (tag) {
                if (tagOwners.has(tag)) errors.push(`Asset tag already belongs to ${tagOwners.get(tag)}.`);
                else tagOwners.set(tag, `CSV row ${rowNumber}`);
            }
            const link = resolveWorkstation(value.linkedWorkstation, workstations);
            if (link.error) errors.push(link.error);
            return { rowNumber, value, errors, linkedWorkstation: link.asset };
        });
    }

    function prepareManualWorkstation(input, assets, excludedAsset) {
        const parsed = model.workstationInput(input);
        const errors = parsed.errors.slice();
        const value = parsed.value;
        const original = excludedAsset ? workstationIdentifiers(excludedAsset) : { serial: '', uuid: '', assetTag: '' };
        const candidate = { serial: value.serial, uuid: value.uuid, assetTag: normalizedKey(value.assetTag) };
        const workstations = (assets || []).filter((asset) => isWorkstation(asset) && (!excludedAsset || asset._id !== excludedAsset._id));

        const fields = [
            { key: 'serial', label: 'Serial number' },
            { key: 'uuid', label: 'UUID' },
            { key: 'assetTag', label: 'Asset tag' }
        ];
        for (const field of fields) {
            const requested = candidate[field.key];
            if (!requested || (excludedAsset && requested === original[field.key])) continue;
            const duplicate = workstations.find((asset) => workstationIdentifiers(asset)[field.key] === requested);
            if (duplicate) errors.push(`${field.label} already belongs to ${duplicate.name || duplicate._id}.`);
        }
        return { value, errors };
    }

    function applyManualWorkstation(asset, value, actor, now) {
        const previousStatus = asset.status;
        asset.name = value.name;
        asset.status = value.status;
        asset.identity = { serial: value.serial, uuid: value.uuid };
        asset.manualHardware = {
            manufacturer: value.manufacturer,
            model: value.model,
            osName: value.osName
        };
        asset.manual = {
            assetTag: value.assetTag,
            location: value.location,
            notes: value.notes,
            purchaseDate: value.purchaseDate,
            warrantyEnd: value.warrantyEnd
        };
        const assignees = value.assignedUser ? [{ id: value.assignedUser.toLowerCase(), display: value.assignedUser, assignedAt: now }] : [];
        asset.assignment = asset.assignment || {};
        asset.assignment.mode = assignees.length ? 'single' : 'unassigned';
        asset.assignment.assignees = assignees;
        asset.assignment.pending = [];
        asset.assignment.ignored = [];
        asset.assignment.resolutions = [];
        asset.assignment.initialized = true;
        asset.updatedAt = now;
        if (previousStatus !== asset.status) {
            model.addHistory(asset, 'lifecycle.changed', actor, `${previousStatus} → ${asset.status}`, now);
        } else {
            model.addHistory(asset, 'workstation.updated', actor, 'Updated manual workstation inventory fields', now);
        }
        return asset;
    }

    function peripheralPreview(prepared) {
        return prepared.map((row) => ({
            rowNumber: row.rowNumber,
            value: row.value,
            errors: row.errors,
            linkedWorkstation: row.linkedWorkstation ? {
                id: row.linkedWorkstation._id,
                name: row.linkedWorkstation.name,
                serial: row.linkedWorkstation.identity && row.linkedWorkstation.identity.serial
            } : null
        }));
    }

    async function createPeripheralRecords(domain, prepared, actor) {
        const invalid = prepared.filter((row) => row.errors.length > 0);
        if (invalid.length > 0) throw new Error(`Import has ${invalid.length} invalid row${invalid.length === 1 ? '' : 's'}. Correct the preview errors before importing.`);
        const created = [];
        try {
            for (const row of prepared) {
                const seed = `peripheral\n${Date.now()}\n${crypto.randomBytes(16).toString('hex')}`;
                const asset = model.createPeripheral(assetId(domain, seed), domain, row.value, actor, Date.now(), row.linkedWorkstation);
                await dbSet(asset);
                created.push(asset);
            }
        } catch (error) {
            if (typeof db.Remove === 'function') {
                for (const asset of created) {
                    try { await dbRemove(asset._id); } catch (rollbackError) { log(`Unable to roll back peripheral ${asset._id}`, rollbackError); }
                }
            }
            throw error;
        }
        return created;
    }

    async function handleBrowserAction(command, session) {
        const action = model.text(command.pluginaction, 64);
        const domain = session.domain.id;

        if (action === 'list') {
            const check = await permissions(session.user, {});
            if (!check('can_view')) throw new Error('Permission denied.');
            await scanDomain(domain, false);
            const assets = (await dbAll('inventoryasset', domain)).filter((asset) => visibleToUser(asset, session.user));
            assets.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            const output = assets.map((asset) => publicAsset(asset, false));
            return { kind: 'list', assets: output, summary: summary(output), permissions: check('_ALL_'), peripheralTypes: model.PERIPHERAL_TYPES };
        }

        if (action === 'get') {
            const asset = await requireAsset(command, session, 'can_view');
            return { kind: 'asset', asset: publicAsset(asset, true) };
        }

        if (action === 'workstation-create') {
            const check = await permissions(session.user, {});
            if (!check('can_manage')) throw new Error('Permission denied.');
            return withQueue(`domain:${domain}`, async () => {
                const assets = await dbAll('inventoryasset', domain);
                const prepared = prepareManualWorkstation(command.workstation || {}, assets, null);
                if (prepared.errors.length > 0) throw new Error(prepared.errors.join(' '));
                const seed = `manual-workstation\n${Date.now()}\n${crypto.randomBytes(16).toString('hex')}`;
                const asset = model.createManualWorkstation(assetId(domain, seed), domain, prepared.value, session.user._id, Date.now());
                await dbSet(asset);
                return { kind: 'workstation-created', asset: publicAsset(asset, true) };
            });
        }

        if (action === 'peripheral-preview' || action === 'peripheral-import' || action === 'peripheral-create') {
            const check = await permissions(session.user, {});
            if (!check('can_manage')) throw new Error('Permission denied.');
            const suppliedRows = action === 'peripheral-create' ? [command.peripheral || {}] : command.rows;
            return withQueue(`domain:${domain}`, async () => {
                const assets = await dbAll('inventoryasset', domain);
                const prepared = preparePeripheralRows(suppliedRows, assets);
                if (action === 'peripheral-preview') {
                    return { kind: 'peripheral-preview', rows: peripheralPreview(prepared) };
                }
                const created = await createPeripheralRecords(domain, prepared, session.user._id);
                return {
                    kind: action === 'peripheral-create' ? 'peripheral-created' : 'peripheral-imported',
                    assets: created.map((asset) => publicAsset(asset, true)),
                    count: created.length
                };
            });
        }

        if (action === 'update') {
            const asset = await requireAsset(command, session, 'can_manage');
            const changes = command.changes && typeof command.changes === 'object' ? command.changes : {};
            const previousStatus = asset.status;
            if (isPeripheral(asset)) {
                return withQueue(`domain:${domain}`, async () => {
                    const currentUser = asset.assignment && asset.assignment.assignees && asset.assignment.assignees[0];
                    const row = {
                        peripheralType: changes.peripheralType !== undefined ? changes.peripheralType : asset.peripheral && asset.peripheral.type,
                        name: changes.name !== undefined ? changes.name : asset.name,
                        assetTag: changes.assetTag !== undefined ? changes.assetTag : asset.manual && asset.manual.assetTag,
                        serial: changes.serial !== undefined ? changes.serial : asset.identity && asset.identity.serial,
                        manufacturer: changes.manufacturer !== undefined ? changes.manufacturer : asset.peripheral && asset.peripheral.manufacturer,
                        model: changes.model !== undefined ? changes.model : asset.peripheral && asset.peripheral.model,
                        assignedUser: changes.assignedUser !== undefined ? changes.assignedUser : currentUser && (currentUser.display || currentUser.id),
                        linkedWorkstation: changes.linkedWorkstation !== undefined ? changes.linkedWorkstation : asset.links && asset.links.workstationAssetId,
                        status: changes.status !== undefined ? changes.status : asset.status,
                        location: changes.location !== undefined ? changes.location : asset.manual && asset.manual.location,
                        purchaseDate: changes.purchaseDate !== undefined ? changes.purchaseDate : asset.manual && asset.manual.purchaseDate,
                        warrantyEnd: changes.warrantyEnd !== undefined ? changes.warrantyEnd : asset.manual && asset.manual.warrantyEnd,
                        notes: changes.notes !== undefined ? changes.notes : asset.manual && asset.manual.notes
                    };
                    const assets = await dbAll('inventoryasset', domain);
                    const prepared = preparePeripheralRows([row], assets, asset._id)[0];
                    if (prepared.errors.length > 0) throw new Error(prepared.errors.join(' '));
                    const value = prepared.value;
                    asset.name = value.name;
                    asset.status = value.status;
                    asset.identity = { serial: value.serial, uuid: '' };
                    asset.peripheral = { type: value.peripheralType, manufacturer: value.manufacturer, model: value.model };
                    asset.links = prepared.linkedWorkstation ? {
                        workstationAssetId: prepared.linkedWorkstation._id,
                        workstationName: prepared.linkedWorkstation.name || '',
                        workstationNodeId: prepared.linkedWorkstation.nodeid || ''
                    } : {};
                    asset.manual = {
                        assetTag: value.assetTag, location: value.location, notes: value.notes,
                        purchaseDate: value.purchaseDate, warrantyEnd: value.warrantyEnd
                    };
                    asset.assignment = asset.assignment || {};
                    asset.assignment.assignees = value.assignedUser ? [{ id: value.assignedUser.toLowerCase(), display: value.assignedUser, assignedAt: Date.now() }] : [];
                    asset.assignment.mode = value.assignedUser ? 'single' : 'unassigned';
                    asset.assignment.initialized = true;
                    asset.assignment.pending = [];
                    asset.updatedAt = Date.now();
                    model.addHistory(asset, 'peripheral.updated', session.user._id, 'Updated manual peripheral inventory fields', asset.updatedAt);
                    await dbSet(asset);
                    return { kind: 'asset', asset: publicAsset(asset, true) };
                });
            }
            if (isManualWorkstation(asset)) {
                return withQueue(`domain:${domain}`, async () => {
                    const currentUser = asset.assignment && asset.assignment.assignees && asset.assignment.assignees[0];
                    const hardware = asset.manualHardware || {};
                    const row = {
                        name: changes.name !== undefined ? changes.name : asset.name,
                        assetTag: changes.assetTag !== undefined ? changes.assetTag : asset.manual && asset.manual.assetTag,
                        serial: changes.serial !== undefined ? changes.serial : asset.identity && asset.identity.serial,
                        uuid: changes.uuid !== undefined ? changes.uuid : asset.identity && asset.identity.uuid,
                        manufacturer: changes.manufacturer !== undefined ? changes.manufacturer : hardware.manufacturer,
                        model: changes.model !== undefined ? changes.model : hardware.model,
                        osName: changes.osName !== undefined ? changes.osName : hardware.osName,
                        assignedUser: changes.assignedUser !== undefined ? changes.assignedUser : currentUser && (currentUser.display || currentUser.id),
                        status: changes.status !== undefined ? changes.status : asset.status,
                        location: changes.location !== undefined ? changes.location : asset.manual && asset.manual.location,
                        purchaseDate: changes.purchaseDate !== undefined ? changes.purchaseDate : asset.manual && asset.manual.purchaseDate,
                        warrantyEnd: changes.warrantyEnd !== undefined ? changes.warrantyEnd : asset.manual && asset.manual.warrantyEnd,
                        notes: changes.notes !== undefined ? changes.notes : asset.manual && asset.manual.notes
                    };
                    const assets = await dbAll('inventoryasset', domain);
                    const prepared = prepareManualWorkstation(row, assets, asset);
                    if (prepared.errors.length > 0) throw new Error(prepared.errors.join(' '));
                    applyManualWorkstation(asset, prepared.value, session.user._id, Date.now());
                    await dbSet(asset);
                    const currentAssets = assets.filter((item) => item._id !== asset._id).concat([asset]);
                    await reconcileCrossSourceDuplicates(domain, currentAssets, session.user._id, asset.updatedAt);
                    return { kind: 'asset', asset: publicAsset(asset, true) };
                });
            }
            if (changes.status !== undefined) {
                if (!model.LIFECYCLE_STATES.includes(changes.status)) throw new Error('Invalid lifecycle state.');
                asset.status = changes.status;
            }
            if (!asset.manual) asset.manual = {};
            const limits = { assetTag: 128, location: 256, notes: 4000, purchaseDate: 32, warrantyEnd: 32 };
            for (const field of Object.keys(limits)) {
                if (changes[field] !== undefined) asset.manual[field] = model.text(changes[field], limits[field]);
            }
            asset.type = 'inventoryasset';
            asset.updatedAt = Date.now();
            if (previousStatus !== asset.status) {
                model.addHistory(asset, 'lifecycle.changed', session.user._id, `${previousStatus} → ${asset.status}`, asset.updatedAt);
            } else {
                model.addHistory(asset, 'asset.updated', session.user._id, 'Updated manual inventory fields', asset.updatedAt);
            }
            await dbSet(asset);
            return { kind: 'asset', asset: publicAsset(asset, true) };
        }

        if (action === 'assignment') {
            const asset = await requireAsset(command, session, 'can_manage');
            const requestedUser = command.user && typeof command.user === 'object' ? command.user : {};
            model.assignmentAction(asset, model.text(command.assignmentAction, 32), requestedUser, session.user._id, Date.now());
            asset.type = 'inventoryasset';
            await dbSet(asset);
            return { kind: 'asset', asset: publicAsset(asset, true) };
        }

        if (action === 'identity') {
            const asset = await requireAsset(command, session, 'can_manage');
            const identityAction = model.text(command.identityAction, 32);
            const requestedConflict = command.conflict && typeof command.conflict === 'object' ? command.conflict : {};
            if (identityAction === 'accept') {
                const field = requestedConflict.kind === 'uuid-mismatch' ? 'uuid' : (requestedConflict.kind === 'serial-mismatch' ? 'serial' : '');
                const observed = field === 'uuid' ? model.normalizeUuid(requestedConflict.observed) : model.normalizeSerial(requestedConflict.observed);
                if (!field || !observed) throw new Error('Invalid reported identity value.');
                const assets = await dbAll('inventoryasset', domain);
                const duplicate = assets.find((item) => item._id !== asset._id && item.identity && item.identity[field] === observed);
                if (duplicate) throw new Error(`The reported ${field} already belongs to another inventory record (${duplicate.name || duplicate._id}).`);
            }
            model.identityConflictAction(asset, identityAction, requestedConflict, session.user._id, Date.now());
            asset.type = 'inventoryasset';
            await dbSet(asset);
            return { kind: 'asset', asset: publicAsset(asset, true) };
        }

        if (action === 'delete') {
            const asset = await requireAsset(command, session, 'can_manage');
            if (command.confirm !== true) throw new Error('Deletion confirmation is required.');
            if (!isPeripheral(asset) && !isManualWorkstation(asset) && (!asset.automatic || asset.automatic.nodeExists !== false)) {
                throw new Error('This inventory record can only be deleted after its MeshCentral node is removed and inventory is synchronized.');
            }
            if (typeof db.Remove !== 'function') throw new Error('This MeshCentral database does not support record deletion.');
            await dbRemove(asset._id);
            if (isManualWorkstation(asset)) await reconcileCrossSourceDuplicates(domain, null, session.user._id, Date.now());
            return { kind: 'deleted', assetId: asset._id };
        }

        if (action === 'rescan') {
            const check = await permissions(session.user, {});
            if (!check('can_sync')) throw new Error('Permission denied.');
            await scanDomain(domain, true);
            return { kind: 'rescan', completedAt: Date.now() };
        }

        throw new Error('Unsupported inventory action.');
    }

    plugin.serveraction = function serveraction(command, session) {
        const requestId = model.text(command.requestId, 128);
        if (!session || !session.user || !session.domain) return;
        handleBrowserAction(command, session)
            .then((result) => send(session, requestId, true, result, null))
            .catch((error) => send(session, requestId, false, null, error.message || String(error)));
    };

    plugin.handleAdminReq = function handleAdminReq(req, res, user) {
        permissions(user, {}).then((check) => {
            if (!check('can_view')) return res.sendStatus(403);
            const nodeid = model.text(req.query.nodeid, 256);
            if (nodeid && !nodeid.startsWith(`node/${user.domain}/`)) return res.sendStatus(400);
            res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.render('inventory', {
                layout: false,
                boot: safeJson({
                    nodeid: nodeid,
                    mode: nodeid ? 'device' : 'dashboard',
                    user: { id: user._id, name: user.name || user._id },
                    permissions: check('_ALL_'),
                    lifecycleStates: model.LIFECYCLE_STATES,
                    peripheralTypes: model.PERIPHERAL_TYPES
                })
            });
        }).catch((error) => {
            log('Unable to render inventory page', error);
            res.sendStatus(500);
        });
    };

    plugin.hook_agentCoreIsStable = function hookAgentCoreIsStable(agent) {
        if (!agent || !agent.dbNodeKey) return;
        Promise.all([dbGet(agent.dbNodeKey), dbGet(`si${agent.dbNodeKey}`)])
            .then(([node, sysinfo]) => syncNode(node, sysinfo, 'agent', true))
            .catch((error) => log(`Agent synchronization failed for ${agent.dbNodeKey}`, error));
    };

    plugin.hook_processAgentData = function hookProcessAgentData(command, agent) {
        if (!command || !agent || !agent.dbNodeKey) return;
        if (command.action !== 'coreinfo' && command.action !== 'sysinfo') return;

        dbGet(agent.dbNodeKey).then((node) => {
            if (!node) return null;
            if (command.action === 'coreinfo') {
                if (Array.isArray(command.users)) node.users = command.users;
                if (Array.isArray(command.upnusers)) node.upnusers = command.upnusers;
                if (typeof command.osdesc === 'string') node.osdesc = command.osdesc;
            }
            return syncNode(node, command.action === 'sysinfo' ? command.data : null, 'agent', command.action === 'coreinfo');
        }).catch((error) => log(`Agent data hook failed for ${agent.dbNodeKey}`, error));
    };

    plugin.server_startup = function serverStartup() {
        // MeshCentral 1.2.5 loads settings.plugins.list entries while its
        // plugin handler is still being constructed. Register here as well so
        // a manual/staging install receives the same permission definitions.
        registerPermissions();
        const timer = setTimeout(() => {
            const domains = root.config && root.config.domains ? Object.keys(root.config.domains) : [''];
            for (const domain of domains) {
                scanDomain(domain, true).catch((error) => log(`Initial scan failed for domain "${domain}"`, error));
            }
        }, 3000);
        if (timer.unref) timer.unref();
    };

    plugin.enforceModernUI = function enforceModernUI() {
        function hideModeSwitches() {
            // MeshCentral 1.2.5 exposes the Modern/Classic selector under this
            // menu item in default3. Keep the theme selector itself available.
            var modernToggle = document.getElementById('toggleModernUIMenuItem');
            if (modernToggle) {
                modernToggle.style.setProperty('display', 'none', 'important');
                modernToggle.setAttribute('aria-hidden', 'true');
            }

            // These are Classic-only controls. Hiding them also prevents a
            // visible flash if the redirect is delayed by a slow connection.
            ['textnewui', 'uiMenuButton', 'uiViewButton7'].forEach(function (id) {
                var element = document.getElementById(id);
                if (element) element.style.setProperty('display', 'none', 'important');
            });
        }

        function persistModernPreference(forceWrite) {
            try {
                if (typeof putstore === 'function') {
                    // putstore does not transmit an unchanged local value. A
                    // forced write is needed after the query-string bridge so
                    // MeshCentral also saves the preference in userWebState.
                    if (forceWrite && window.localStorage && window.localStorage.getItem('uiViewMode') === '3') {
                        window.localStorage.removeItem('uiViewMode');
                    }
                    putstore('uiViewMode', 3);
                    return true;
                }
            } catch (error) { /* Retry after the MeshCentral socket is ready. */ }
            try {
                if (window.localStorage) window.localStorage.setItem('uiViewMode', '3');
            } catch (error) { /* Local storage can be disabled by the browser. */ }
            return false;
        }

        hideModeSwitches();
        var modern = document.getElementById('theme-stylesheet') != null;
        var url;
        try { url = new URL(window.location.href); } catch (error) { url = null; }

        if (!modern) {
            persistModernPreference(false);
            if (url && url.searchParams.get('sitestyle') !== '3') {
                url.searchParams.set('sitestyle', '3');
                window.location.replace(url.pathname + url.search + url.hash);
            }
            return false;
        }

        var bridged = !!(url && url.searchParams.get('sitestyle') === '3');
        var attempts = 0;
        function finishPreferenceUpdate() {
            hideModeSwitches();
            if (persistModernPreference(bridged)) {
                if (bridged && url) {
                    url.searchParams.delete('sitestyle');
                    if (typeof urlargs === 'object' && urlargs != null) delete urlargs.sitestyle;
                    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
                }
                return;
            }
            attempts++;
            if (attempts < 40) window.setTimeout(finishPreferenceUpdate, 250);
        }
        finishPreferenceUpdate();

        // Some menu contents are refreshed after startup. Keep only the UI
        // mode selector hidden if MeshCentral recreates it.
        try {
            var observer = new MutationObserver(hideModeSwitches);
            observer.observe(document.body, { childList: true, subtree: true });
        } catch (error) { /* Static menus need no observer. */ }
        return true;
    };

    plugin.onWebUIStartupEnd = function onWebUIStartupEnd() {
        if (pluginHandler.inventory.enforceModernUI() === false) return;
        pluginHandler.inventory.installNavigation();
        try {
            var params = new URLSearchParams(window.location.search);
            var inventoryRoute = params.get('inventoryplugin') === '1' || params.has('inventorytab') || params.has('inventoryasset');
            if (params.get('viewmode') === '43' && inventoryRoute) {
                // Preserve an explicitly opened asset only while restoring the
                // same Inventory URL after a browser refresh.
                pluginHandler.inventory.openInventory(true);
            }
        } catch (error) { /* URL restoration is best effort. */ }
    };

    plugin.setInventoryUrlMarker = function setInventoryUrlMarker(enabled, clearTab) {
        try {
            if (typeof urlargs === 'object' && urlargs != null) {
                if (enabled) urlargs.inventoryplugin = '1';
                else {
                    delete urlargs.inventoryplugin;
                    delete urlargs.inventoryasset;
                    if (clearTab === true) delete urlargs.inventorytab;
                }
            }
            var url = new URL(window.location.href);
            if (enabled) {
                url.searchParams.set('viewmode', '43');
                url.searchParams.set('inventoryplugin', '1');
            } else {
                url.searchParams.delete('inventoryplugin');
                url.searchParams.delete('inventoryasset');
                if (clearTab === true) url.searchParams.delete('inventorytab');
            }
            window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
        } catch (error) { /* History updates are best effort. */ }
        // MeshCentral only clears selection classes for its built-in menu IDs.
        // Clear the custom item here as well whenever navigation removes the
        // Inventory URL marker. This path is invoked reliably by goPageStart.
        if (!enabled) {
            var top = document.getElementById('MainMenuInventory');
            if (top) top.classList.remove('style3sel', 'fullselect', 'semiselect');
            var left = document.getElementById('LeftMenuInventory');
            if (left) left.classList.remove('active', 'lbbuttonsel', 'lbbuttonsel2');
        }
    };

    plugin.goPageStart = function goPageStart(page) {
        if (page !== 43) {
            pluginHandler.inventory.setInventoryUrlMarker(false);
            pluginHandler.inventory.setInventoryHeading(false);
            pluginHandler.inventory.setInventorySelected(false);
        }
    };

    plugin.setInventorySelected = function setInventorySelected(enabled) {
        var top = document.getElementById('MainMenuInventory');
        if (top) {
            top.classList.toggle('style3sel', enabled === true);
            if (!enabled) top.classList.remove('fullselect', 'semiselect');
        }
        var left = document.getElementById('LeftMenuInventory');
        if (left) {
            left.classList.toggle('active', enabled === true);
            left.classList.toggle('lbbuttonsel', enabled === true);
            if (!enabled) left.classList.remove('lbbuttonsel2');
        }
    };

    plugin.inventoryBack = function inventoryBack(event) {
        try {
            var frame = document.getElementById('p43iframe');
            if (frame && frame.contentWindow && frame.contentWindow.InventoryApp && frame.contentWindow.InventoryApp.back()) {
                if (event) event.preventDefault();
                return false;
            }
        } catch (error) { /* Fall through to My Devices if the frame is unavailable. */ }
        pluginHandler.inventory.setInventoryUrlMarker(false);
        go(1, event);
        return false;
    };

    plugin.setInventoryHeading = function setInventoryHeading(enabled) {
        var title = document.getElementById('p43title');
        var heading = title && title.parentNode;
        var back = document.querySelector('#p43BackButton .backButton');
        if (!heading) return;
        if (enabled) {
            if (!heading.hasAttribute('data-inventory-original-heading')) {
                heading.setAttribute('data-inventory-original-heading', heading.innerHTML);
            }
            heading.textContent = '';
            var inventoryTitle = document.createElement('span');
            inventoryTitle.id = 'p43title';
            inventoryTitle.textContent = 'Inventory';
            heading.appendChild(inventoryTitle);
            if (back) {
                if (!back.hasAttribute('data-inventory-original-mouseup')) {
                    back.setAttribute('data-inventory-original-mouseup', back.getAttribute('onmouseup') || '');
                    back.setAttribute('data-inventory-original-keypress', back.getAttribute('onkeypress') || '');
                }
                back.removeAttribute('onmouseup');
                back.removeAttribute('onkeypress');
                back.onmouseup = function (event) { return pluginHandler.inventory.inventoryBack(event); };
                back.onkeypress = function (event) {
                    if (event.key === 'Enter') return pluginHandler.inventory.inventoryBack(event);
                };
            }
        } else if (heading.hasAttribute('data-inventory-original-heading')) {
            heading.innerHTML = heading.getAttribute('data-inventory-original-heading');
            heading.removeAttribute('data-inventory-original-heading');
            if (back && back.hasAttribute('data-inventory-original-mouseup')) {
                var originalMouseup = back.getAttribute('data-inventory-original-mouseup');
                var originalKeypress = back.getAttribute('data-inventory-original-keypress');
                back.onmouseup = null;
                back.onkeypress = null;
                if (originalMouseup) back.setAttribute('onmouseup', originalMouseup); else back.removeAttribute('onmouseup');
                if (originalKeypress) back.setAttribute('onkeypress', originalKeypress); else back.removeAttribute('onkeypress');
                back.removeAttribute('data-inventory-original-mouseup');
                back.removeAttribute('data-inventory-original-keypress');
            }
        }
    };

    plugin.installNavigation = function installNavigation() {
        if (!document.getElementById('MainMenuInventory')) {
            var row = document.querySelector('#MainMenuSpan tr');
            if (row) {
                var cell = document.createElement('td');
                cell.id = 'MainMenuInventory';
                cell.tabIndex = 0;
                cell.className = 'topbar_td style3x';
                cell.textContent = 'Inventory';
                cell.onmouseup = function () { return pluginHandler.inventory.openInventory(); };
                cell.onkeypress = function (event) { if (event.key === 'Enter') pluginHandler.inventory.openInventory(); };
                var devicesCell = document.getElementById('MainMenuMyDevices');
                row.insertBefore(cell, devicesCell && devicesCell.parentNode === row ? devicesCell.nextSibling : row.querySelector('.topbar_td_end'));
            }
        }

        if (!document.getElementById('LeftMenuInventory')) {
            var devicesItem = document.getElementById('LeftMenuMyDevices');
            if (devicesItem && devicesItem.parentNode) {
                var item = devicesItem.cloneNode(false);
                item.id = 'LeftMenuInventory';
                item.title = 'Inventory';
                item.className = devicesItem.className.replace(/lbbuttonsel/g, '').replace(/active/g, '');
                item.removeAttribute('data-target');
                item.removeAttribute('onmouseup');
                item.removeAttribute('onkeypress');
                item.innerHTML = '<i class="fa-solid fa-boxes-stacked me-2"></i>';
                item.onclick = function (event) { if (event) event.preventDefault(); return pluginHandler.inventory.openInventory(); };
                devicesItem.parentNode.insertBefore(item, devicesItem.nextSibling);
            }
        }
        pluginHandler.inventory.trackPluginFrame();
    };

    plugin.trackPluginFrame = function trackPluginFrame() {
        var frame = document.getElementById('p43iframe');
        if (!frame || frame.getAttribute('data-inventory-frame-watch') === '1') return;
        frame.setAttribute('data-inventory-frame-watch', '1');
        try {
            new MutationObserver(function () {
                var source = frame.getAttribute('src') || '';
                // Page 43 is shared by every server plugin. If another plugin
                // takes ownership of it, remove Inventory's route and visual
                // selection so a later refresh cannot restore the wrong one.
                if (source && source.indexOf('pin=inventory') < 0) {
                    pluginHandler.inventory.setInventoryUrlMarker(false, true);
                    pluginHandler.inventory.setInventoryHeading(false);
                    pluginHandler.inventory.setInventorySelected(false);
                }
            }).observe(frame, { attributes: true, attributeFilter: ['src'] });
        } catch (error) { /* Older browsers can operate without the watcher. */ }
    };

    plugin.openInventory = function openInventory(preserveDetail) {
        // A click on the main Inventory navigation is an explicit request for
        // the dashboard. Do not carry a previously opened asset across visits
        // from My Devices or another MeshCentral page. Startup restoration
        // passes true so refreshing an open asset still restores that asset.
        var preservedAsset = '';
        var preservedTab = '';
        if (preserveDetail === true) {
            try {
                var currentUrl = new URL(window.location.href);
                preservedAsset = currentUrl.searchParams.get('inventoryasset') || '';
                preservedTab = currentUrl.searchParams.get('inventorytab') || '';
            } catch (error) { /* Route restoration is best effort. */ }
        }
        if (preserveDetail !== true) {
            try {
                if (typeof urlargs === 'object' && urlargs != null) delete urlargs.inventoryasset;
                var dashboardUrl = new URL(window.location.href);
                dashboardUrl.searchParams.delete('inventoryasset');
                window.history.replaceState({}, document.title, dashboardUrl.pathname + dashboardUrl.search + dashboardUrl.hash);
            } catch (error) { /* URL cleanup is best effort. */ }
        }
        pluginHandler.inventory.setInventoryUrlMarker(true);
        goPlugin('inventory', 'Inventory');
        // goPlugin rebuilds MeshCentral's query string from its own recognized
        // arguments. Reapply our private route after that rebuild so the iframe
        // can restore the same asset on a full browser refresh.
        if (preserveDetail === true && preservedAsset) {
            try {
                if (typeof urlargs === 'object' && urlargs != null) {
                    urlargs.inventoryasset = preservedAsset;
                    if (preservedTab) urlargs.inventorytab = preservedTab;
                }
                var restoredUrl = new URL(window.location.href);
                restoredUrl.searchParams.set('inventoryasset', preservedAsset);
                if (preservedTab) restoredUrl.searchParams.set('inventorytab', preservedTab);
                window.history.replaceState({}, document.title, restoredUrl.pathname + restoredUrl.search + restoredUrl.hash);
            } catch (error) { /* Route restoration is best effort. */ }
        }
        setTimeout(function () {
            pluginHandler.inventory.setInventoryHeading(true);
            pluginHandler.inventory.setInventorySelected(true);
        }, 0);
        return false;
    };

    plugin.onDeviceRefreshEnd = function onDeviceRefreshEnd(nodeid) {
        pluginHandler.registerPluginTab({ tabId: 'pluginInventory', tabTitle: 'Inventory' });
        var panel = document.getElementById('pluginInventory');
        if (panel) {
            var frame = panel.querySelector('iframe.inventory-plugin-frame');
            var frameSource = '/pluginadmin.ashx?pin=inventory&nodeid=' + encodeURIComponent(nodeid);
            if (!frame) {
                frame = document.createElement('iframe');
                frame.className = 'inventory-plugin-frame';
                frame.setAttribute('frameborder', '0');
                frame.style.width = '100%';
                frame.style.height = 'calc(100vh - 190px)';
                frame.style.minHeight = '560px';
                panel.appendChild(frame);
            }
            // MeshCentral can reuse the plugin tab container while navigating
            // directly from one device to another. Reload the iframe whenever
            // its endpoint identity changes so it cannot show the prior node.
            if (frame.getAttribute('data-inventory-nodeid') !== nodeid) {
                frame.setAttribute('data-inventory-nodeid', nodeid);
                frame.src = frameSource;
            }
        }
    };

    plugin.receiveInventoryMessage = function receiveInventoryMessage(server, message) {
        var frames = [];
        var main = document.getElementById('p43iframe');
        if (main) frames.push(main);
        var embedded = document.querySelectorAll('iframe.inventory-plugin-frame');
        for (var i = 0; i < embedded.length; i++) frames.push(embedded[i]);
        for (var j = 0; j < frames.length; j++) {
            try {
                if (frames[j].contentWindow && frames[j].contentWindow.InventoryApp) {
                    if (frames[j].contentWindow.InventoryApp.receive(message) === true) break;
                }
            } catch (error) { /* Ignore unloaded frames. */ }
        }
    };

    plugin.exports = [
        'onWebUIStartupEnd',
        'enforceModernUI',
        'installNavigation',
        'trackPluginFrame',
        'setInventoryUrlMarker',
        'setInventoryHeading',
        'setInventorySelected',
        'inventoryBack',
        'goPageStart',
        'openInventory',
        'onDeviceRefreshEnd',
        'receiveInventoryMessage'
    ];

    return plugin;
};
