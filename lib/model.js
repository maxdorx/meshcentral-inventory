'use strict';

const LIFECYCLE_STATES = Object.freeze([
    'Discovered',
    'Available',
    'Assigned',
    'In Repair',
    'Retired',
    'Lost/Stolen'
]);

const PERIPHERAL_TYPES = Object.freeze([
    'Mouse',
    'Keyboard',
    'Headset',
    'Monitor',
    'Other'
]);

const INVALID_IDENTIFIERS = new Set([
    '', '0', '00', '00000000', '000000000000', '0000000000000000',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    'default string', 'none', 'not applicable', 'not available', 'n/a',
    'system serial number', 'to be filled by o.e.m.', 'to be filled by oem',
    'oem chassis serial number', 'chassis serial number', 'unknown', 'undefined'
]);

function text(value, maxLength) {
    if (value === null || value === undefined) return '';
    const result = String(value).trim();
    return result.substring(0, maxLength || 512);
}

function normalizeUuid(value) {
    let result = text(value, 128).toLowerCase();
    result = result.replace(/^urn:uuid:/, '').replace(/[{}]/g, '');
    if (INVALID_IDENTIFIERS.has(result)) return '';
    if (/^0+$/.test(result.replace(/-/g, ''))) return '';
    if (/^f+$/.test(result.replace(/-/g, ''))) return '';
    return result;
}

function normalizeSerial(value) {
    const result = text(value, 128).replace(/\s+/g, ' ').toUpperCase();
    if (INVALID_IDENTIFIERS.has(result.toLowerCase())) return '';
    if (/^[0-]+$/.test(result)) return '';
    return result;
}

function normalizePeripheralType(value) {
    const input = text(value, 64).toLowerCase();
    const aliases = {
        mouse: 'Mouse', keyboard: 'Keyboard',
        headset: 'Headset', headsets: 'Headset', headphone: 'Headset', headphones: 'Headset',
        monitor: 'Monitor', monitors: 'Monitor', lcd: 'Monitor', lcds: 'Monitor', display: 'Monitor',
        other: 'Other'
    };
    return aliases[input] || '';
}

function normalizeDate(value) {
    const input = text(value, 32);
    if (!input) return '';
    let match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let year, month, day;
    if (match) {
        year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
    } else {
        match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return '';
        day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeUser(value) {
    const display = text(value, 256);
    if (!display) return null;

    const lower = display.toLowerCase();
    const ignoredExact = new Set([
        'system', 'local service', 'network service', 'defaultuser0',
        'font driver host', 'window manager', 'gdm', 'gdm-greeter',
        'lightdm', 'sddm', 'loginwindow', 'daemon', 'nobody'
    ]);
    const ignoredPrefixes = ['dwm-', 'umfd-'];
    const localName = lower.includes('\\') ? lower.substring(lower.lastIndexOf('\\') + 1) : lower.split('@')[0];
    if (ignoredExact.has(lower) || ignoredExact.has(localName) || ignoredPrefixes.some((item) => localName.startsWith(item))) return null;

    return { id: lower, display: display };
}

function normalizeIgnoredUsers(values) {
    if (!Array.isArray(values) || values.length > 100) throw new Error('Provide at most 100 ignored accounts.');
    const result = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string') throw new Error('Each ignored account must be a username.');
        const name = value.trim().toLowerCase();
        if (!name || name.length > 256 || /[,\r\n\x00-\x1f\x7f]/.test(name)) throw new Error('Each ignored account must be a valid username of at most 256 characters.');
        if (!seen.has(name)) { seen.add(name); result.push(name); }
    }
    return result;
}

function ignoredUserMatches(user, ignoredUsers) {
    const id = text(user && (user.id || user.display), 256).toLowerCase();
    if (!id || !Array.isArray(ignoredUsers) || ignoredUsers.length === 0) return false;
    if (ignoredUsers.includes(id)) return true;
    const local = id.includes('\\') ? id.substring(id.lastIndexOf('\\') + 1) : id.split('@')[0];
    return ignoredUsers.includes(local);
}

function uniqueUsers(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const user = normalizeUser(value);
        if (!user || seen.has(user.id)) continue;
        seen.add(user.id);
        result.push(user);
    }
    return result;
}

function reportedUsers(source, ignoredUsers) {
    if (!source || typeof source !== 'object') return [];
    const upn = uniqueUsers(source.upnusers).filter((user) => !ignoredUserMatches(user, ignoredUsers));
    return upn.length > 0 ? upn : uniqueUsers(source.users).filter((user) => !ignoredUserMatches(user, ignoredUsers));
}

function parseMemoryBytes(hardware) {
    let total = 0;
    try {
        if (hardware.windows && Array.isArray(hardware.windows.memory)) {
            for (const item of hardware.windows.memory) total += Number(item.Capacity) || 0;
        } else if (hardware.darwin && Array.isArray(hardware.darwin.memory)) {
            for (const item of hardware.darwin.memory) total += Number(item.Capacity || item.Size) || 0;
        } else if (hardware.linux && hardware.linux.memory && Array.isArray(hardware.linux.memory.Memory_Device)) {
            for (const item of hardware.linux.memory.Memory_Device) {
                const value = text(item.Size, 64);
                const match = value.match(/^([\d.]+)\s*(KB|MB|GB|TB)/i);
                if (!match) continue;
                const power = { KB: 1, MB: 2, GB: 3, TB: 4 }[match[2].toUpperCase()];
                total += Number(match[1]) * Math.pow(1024, power);
            }
        }
    } catch (error) { /* Best-effort agent data. */ }
    return Math.round(total);
}

function simplifiedStorage(identifiers) {
    const result = [];
    const devices = identifiers && Array.isArray(identifiers.storage_devices) ? identifiers.storage_devices : [];
    for (const device of devices.slice(0, 32)) {
        result.push({
            name: text(device.Caption || device.Name || device.Device || '', 256),
            model: text(device.Model || '', 256),
            serial: text(device.SerialNumber || device.Serial || '', 128),
            size: Number(device.Size) || text(device.Size || '', 64)
        });
    }
    return result;
}

function snapshotFrom(node, sysinfo, meshName, online, lastConnectTime, ignoredUsers) {
    node = node || {};
    sysinfo = sysinfo || {};
    const hardware = sysinfo.hardware || {};
    const identifiers = hardware.identifiers || {};

    const serialCandidates = [
        identifiers.chassis_serial,
        identifiers.bios_serial,
        identifiers.board_serial
    ];
    let serial = '';
    for (const candidate of serialCandidates) {
        serial = normalizeSerial(candidate);
        if (serial) break;
    }

    return {
        nodeid: text(node._id, 256),
        meshid: text(node.meshid, 256),
        meshName: text(meshName, 256),
        name: text(node.name || node.rname, 256),
        osName: text(node.osdesc, 512),
        agentType: node.agent && node.agent.id !== undefined ? node.agent.id : null,
        agentVersion: node.agent && node.agent.ver !== undefined ? text(node.agent.ver, 64) : '',
        publicIp: text(node.ip, 128),
        serial: serial,
        uuid: normalizeUuid(identifiers.product_uuid),
        manufacturer: text(identifiers.chassis_manufacturer || identifiers.board_vendor || identifiers.bios_vendor, 256),
        model: text(identifiers.product_name || identifiers.board_name, 256),
        assetTagReported: text(identifiers.chassis_assettag, 128),
        cpu: text(identifiers.cpu_name, 512),
        memoryBytes: parseMemoryBytes(hardware),
        storage: simplifiedStorage(identifiers),
        pendingReboot: sysinfo.pendingReboot || null,
        sysinfoTime: Number(sysinfo.time) || null,
        lastConnectTime: Number(lastConnectTime) || null,
        online: online === true,
        reportedUsers: reportedUsers(node, ignoredUsers),
        userReportAuthoritative: online === true
    };
}

function sameIdentity(asset, snapshot) {
    const identity = asset && asset.identity ? asset.identity : {};
    // UUID is stronger than serial. If both sides have UUIDs, a different UUID
    // must not be merged merely because an OEM reused a serial value.
    if (snapshot.uuid && identity.uuid) return snapshot.uuid === identity.uuid;
    return Boolean(snapshot.serial && identity.serial === snapshot.serial);
}

function identityConflicts(asset, snapshot) {
    const conflicts = [];
    const identity = asset && asset.identity ? asset.identity : {};
    if (snapshot.uuid && identity.uuid && snapshot.uuid !== identity.uuid) {
        conflicts.push({ kind: 'uuid-mismatch', expected: identity.uuid, observed: snapshot.uuid });
    }
    if (snapshot.serial && identity.serial && snapshot.serial !== identity.serial) {
        conflicts.push({ kind: 'serial-mismatch', expected: identity.serial, observed: snapshot.serial });
    }
    return conflicts;
}

function sameConflict(left, right) {
    return left && right && left.kind === right.kind && left.expected === right.expected && left.observed === right.observed;
}

function selectAsset(assets, snapshot) {
    const matches = (assets || []).filter((asset) => sameIdentity(asset, snapshot));
    if (matches.length === 0) return { asset: null, conflicts: [] };

    matches.sort((a, b) => {
        const aUuid = Boolean(snapshot.uuid && a.identity && a.identity.uuid === snapshot.uuid);
        const bUuid = Boolean(snapshot.uuid && b.identity && b.identity.uuid === snapshot.uuid);
        if (aUuid !== bUuid) return aUuid ? -1 : 1;
        return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
    });

    const selected = matches[0];
    const conflicts = [];
    if (matches.length > 1) {
        conflicts.push({
            kind: 'duplicate-match',
            assetIds: matches.map((item) => item._id),
            message: 'More than one inventory record matches this hardware identity.'
        });
    }

    conflicts.push(...identityConflicts(selected, snapshot));

    return { asset: selected, conflicts: conflicts };
}

function addHistory(asset, action, actor, details, at) {
    if (!Array.isArray(asset.history)) asset.history = [];
    asset.history.push({
        at: Number(at) || Date.now(),
        action: text(action, 64),
        actor: text(actor || 'system', 256),
        details: text(details || '', 1024)
    });
    if (asset.history.length > 200) asset.history = asset.history.slice(-200);
}

function ensureAssignment(asset) {
    if (!asset.assignment) {
        asset.assignment = {
            mode: 'unassigned', assignees: [], pending: [], ignored: [], resolutions: [], initialized: false
        };
    }
    const assignment = asset.assignment;
    if (!Array.isArray(assignment.assignees)) assignment.assignees = [];
    if (!Array.isArray(assignment.pending)) assignment.pending = [];
    if (!Array.isArray(assignment.ignored)) assignment.ignored = [];
    if (!Array.isArray(assignment.resolutions)) assignment.resolutions = [];

    // Migrate the original permanent ignored-user list into presence-cycle
    // decisions. It stays suppressed until an authoritative report first
    // shows the user absent, after which a return creates a new review.
    for (const id of assignment.ignored) {
        if (!assignment.resolutions.some((item) => item.id === id)) {
            assignment.resolutions.push({
                id: id,
                display: id,
                decision: 'dismissed',
                decidedAt: asset.updatedAt || asset.createdAt || Date.now(),
                decidedBy: 'migration',
                armed: false
            });
        }
    }
    assignment.ignored = [];
    return assignment;
}

function currentUserIds(asset) {
    return new Set((asset.currentUsers || []).map((item) => item.id));
}

function recordResolution(asset, user, decision, actor, now, permanent) {
    const assignment = ensureAssignment(asset);
    const id = text(user && user.id, 256).toLowerCase();
    if (!id) return;
    const display = text(user && (user.display || user.id), 256) || id;
    const present = currentUserIds(asset).has(id);
    const existing = assignment.resolutions.find((item) => item.id === id);
    const value = existing || { id: id };
    value.display = display;
    value.decision = decision;
    value.decidedAt = now;
    value.decidedBy = text(actor || 'system', 256);
    value.armed = permanent === true ? false : !present;
    value.permanent = permanent === true;
    delete value.triggeredAt;
    if (!existing) assignment.resolutions.push(value);
    if (assignment.resolutions.length > 200) assignment.resolutions = assignment.resolutions.slice(-200);
}

function removeResolution(asset, id) {
    const assignment = ensureAssignment(asset);
    assignment.resolutions = assignment.resolutions.filter((item) => item.id !== id);
}

function cleanServiceAccounts(asset, now) {
    const assignment = ensureAssignment(asset);
    const removed = [];
    assignment.assignees = assignment.assignees.filter((item) => {
        if (normalizeUser(item.id || item.display)) return true;
        removed.push(item);
        return false;
    });
    assignment.pending = assignment.pending.filter((item) => {
        if (normalizeUser(item.id || item.display)) return true;
        removed.push(item);
        return false;
    });
    for (const user of removed) recordResolution(asset, user, 'service-account', 'system', now, true);
    if (removed.length > 0) {
        addHistory(asset, 'assignment.service-account-removed', 'system', `Removed non-human account(s): ${removed.map((item) => item.display || item.id).join(', ')}`, now);
        if (assignment.assignees.length === 0) {
            assignment.mode = 'unassigned';
            assignment.initialized = false;
            if (!['In Repair', 'Retired', 'Lost/Stolen'].includes(asset.status)) asset.status = 'Available';
        }
    }
}

function applyIgnoredUsers(asset, ignoredUsers, now) {
    if (!Array.isArray(ignoredUsers) || ignoredUsers.length === 0) return false;
    const assignment = ensureAssignment(asset);
    const pending = assignment.pending.filter((user) => !ignoredUserMatches(user, ignoredUsers));
    const assignees = assignment.assignees.filter((user) => user.source === 'manual' || !ignoredUserMatches(user, ignoredUsers));
    const removedAssignees = assignment.assignees.filter((user) => user.source !== 'manual' && ignoredUserMatches(user, ignoredUsers));
    const resolutions = assignment.resolutions.filter((user) => !ignoredUserMatches(user, ignoredUsers));
    const currentUsers = (asset.currentUsers || []).filter((user) => !ignoredUserMatches(user, ignoredUsers));
    const changed = pending.length !== assignment.pending.length || assignees.length !== assignment.assignees.length ||
        resolutions.length !== assignment.resolutions.length || currentUsers.length !== (asset.currentUsers || []).length;
    if (!changed) return false;
    const removed = [...assignment.pending.filter((user) => ignoredUserMatches(user, ignoredUsers)), ...removedAssignees];
    assignment.pending = pending;
    assignment.assignees = assignees;
    assignment.resolutions = resolutions;
    asset.currentUsers = currentUsers;
    if (removedAssignees.length > 0) assignment.mode = assignees.length > 1 ? 'shared' : assignees.length ? 'single' : 'unassigned';
    if (assignees.length === 0 && removedAssignees.length > 0) {
        assignment.initialized = false;
        if (!['In Repair', 'Retired', 'Lost/Stolen'].includes(asset.status)) asset.status = 'Available';
    }
    if (removed.length > 0) addHistory(asset, 'assignment.account-ignored', 'system', `Ignored account(s): ${[...new Set(removed.map((user) => user.display || user.id))].join(', ')}`, now);
    asset.updatedAt = now;
    return true;
}

function observeUsers(asset, users, now) {
    const assignment = ensureAssignment(asset);
    cleanServiceAccounts(asset, now);
    if (!Array.isArray(asset.observedUsers)) asset.observedUsers = [];

    users = Array.isArray(users) ? users : [];
    asset.currentUsers = users.map((user) => ({ id: user.id, display: user.display, reportedAt: now }));

    const known = new Map(asset.observedUsers.map((item) => [item.id, item]));
    for (const user of users || []) {
        let observation = known.get(user.id);
        if (!observation) {
            observation = { id: user.id, display: user.display, firstSeen: now, lastSeen: now, sightings: 0 };
            asset.observedUsers.push(observation);
            known.set(user.id, observation);
        }
        observation.display = user.display;
        observation.lastSeen = now;
        observation.sightings = (Number(observation.sightings) || 0) + 1;
    }

    if (users.length > 0 && !assignment.initialized) {
        const first = users[0];
        assignment.mode = 'single';
        assignment.assignees = [{ id: first.id, display: first.display, assignedAt: now, source: 'agent' }];
        assignment.initialized = true;
        if (!['In Repair', 'Retired', 'Lost/Stolen'].includes(asset.status)) asset.status = 'Assigned';
        addHistory(asset, 'assignment.auto', 'agent', `Automatically assigned to ${first.display}`, now);
    }

    const assigned = new Set(assignment.assignees.map((item) => item.id));
    const pending = new Set(assignment.pending.map((item) => item.id));
    const present = new Set(users.map((item) => item.id));

    // A handled observation is suppressed only for the current presence
    // cycle. Once the user is absent, the decision is armed. A later return
    // creates exactly one new pending review and disarms it again.
    for (const resolution of assignment.resolutions) {
        if (resolution.permanent === true || assigned.has(resolution.id)) continue;
        if (!present.has(resolution.id)) {
            if (resolution.armed !== true) {
                resolution.armed = true;
                resolution.lastAbsentAt = now;
                addHistory(asset, 'assignment.absent', 'agent', `${resolution.display || resolution.id} is no longer reported; return monitoring armed.`, now);
            }
        } else if (resolution.armed === true && !pending.has(resolution.id)) {
            const user = users.find((item) => item.id === resolution.id) || resolution;
            assignment.pending.push({ id: user.id, display: user.display || user.id, firstSeen: now, lastSeen: now });
            pending.add(user.id);
            resolution.armed = false;
            resolution.triggeredAt = now;
            addHistory(asset, 'assignment.returned', 'agent', `Previously handled user returned: ${user.display || user.id}`, now);
        }
    }

    for (const user of users) {
        if (assigned.has(user.id) || pending.has(user.id)) continue;
        const resolution = assignment.resolutions.find((item) => item.id === user.id);
        if (resolution && (resolution.permanent === true || resolution.armed !== true)) continue;
        assignment.pending.push({ id: user.id, display: user.display, firstSeen: now, lastSeen: now });
        pending.add(user.id);
        addHistory(asset, 'assignment.review', 'agent', `New signed-in user observed: ${user.display}`, now);
    }

    for (const pendingUser of assignment.pending) {
        const seen = known.get(pendingUser.id);
        if (seen) pendingUser.lastSeen = now;
    }
}

function createAsset(id, domain, snapshot, now) {
    const asset = {
        _id: id,
        type: 'inventoryasset',
        domain: domain,
        schemaVersion: 2,
        assetKind: 'workstation',
        source: 'automatic',
        createdAt: now,
        updatedAt: now,
        status: (snapshot.serial || snapshot.uuid) ? 'Available' : 'Discovered',
        identity: { serial: snapshot.serial, uuid: snapshot.uuid },
        nodeids: snapshot.nodeid ? [snapshot.nodeid] : [],
        nodeid: snapshot.nodeid,
        meshid: snapshot.meshid,
        meshName: snapshot.meshName,
        name: snapshot.name,
        automatic: {},
        manual: { assetTag: '', location: '', notes: '', purchaseDate: '', warrantyEnd: '' },
        assignment: { mode: 'unassigned', assignees: [], pending: [], ignored: [], resolutions: [], initialized: false },
        recordState: 'Active',
        reviews: [],
        observedUsers: [],
        identityConflicts: [],
        identityResolutions: [],
        history: []
    };
    addHistory(asset, 'asset.created', 'system', `Discovered from ${snapshot.name || snapshot.nodeid}`, now);
    return asset;
}

function workstationInput(input) {
    input = input && typeof input === 'object' ? input : {};
    const rawSerial = text(input.serial, 128);
    const rawUuid = text(input.uuid, 128);
    const rawPurchaseDate = text(input.purchaseDate || input.purchase_date, 32);
    const rawWarrantyEnd = text(input.warrantyEnd || input.warranty_end, 32);
    const result = {
        name: text(input.name, 256),
        assetTag: text(input.assetTag || input.asset_tag, 128),
        serial: normalizeSerial(rawSerial),
        uuid: normalizeUuid(rawUuid),
        manufacturer: text(input.manufacturer, 256),
        model: text(input.model, 256),
        osName: text(input.osName || input.os_name || input.operatingSystem || input.operating_system, 512),
        assignedUser: text(input.assignedUser || input.assigned_user, 256),
        status: text(input.status, 64),
        location: text(input.location, 256),
        purchaseDate: normalizeDate(rawPurchaseDate),
        warrantyEnd: normalizeDate(rawWarrantyEnd),
        notes: text(input.notes, 4000)
    };
    const errors = [];
    if (!result.name) errors.push('Workstation name is required.');
    if (rawSerial && !result.serial) errors.push('Serial number is a placeholder or invalid.');
    if (rawUuid && !result.uuid) errors.push('UUID is a placeholder or invalid.');
    if (rawPurchaseDate && !result.purchaseDate) errors.push('Purchase date must be YYYY-MM-DD or DD/MM/YYYY.');
    if (rawWarrantyEnd && !result.warrantyEnd) errors.push('Warranty end must be YYYY-MM-DD or DD/MM/YYYY.');
    if (result.status) {
        const matchingStatus = LIFECYCLE_STATES.find((item) => item.toLowerCase() === result.status.toLowerCase());
        if (matchingStatus) result.status = matchingStatus;
        else errors.push(`Status must be one of: ${LIFECYCLE_STATES.join(', ')}.`);
    }
    if (!result.status) result.status = result.assignedUser ? 'Assigned' : 'Available';
    if (result.status === 'Assigned' && !result.assignedUser) errors.push('Assigned user is required when status is Assigned.');
    if (result.assignedUser && result.status !== 'Assigned') errors.push('Status must be Assigned when an assigned user is provided.');
    return { value: result, errors };
}

function createManualWorkstation(id, domain, input, actor, now) {
    const parsed = workstationInput(input);
    if (parsed.errors.length > 0) throw new Error(parsed.errors.join(' '));
    const value = parsed.value;
    const assignees = value.assignedUser ? [{ id: value.assignedUser.toLowerCase(), display: value.assignedUser, assignedAt: now, source: 'manual' }] : [];
    const asset = {
        _id: id,
        type: 'inventoryasset',
        domain,
        schemaVersion: 3,
        assetKind: 'workstation',
        source: 'manual',
        createdAt: now,
        updatedAt: now,
        status: value.status,
        identity: { serial: value.serial, uuid: value.uuid },
        nodeids: [],
        nodeid: '',
        meshName: '',
        name: value.name,
        automatic: { online: false, nodeExists: false, lastSeen: null },
        manualHardware: {
            manufacturer: value.manufacturer,
            model: value.model,
            osName: value.osName
        },
        manual: {
            assetTag: value.assetTag,
            location: value.location,
            notes: value.notes,
            purchaseDate: value.purchaseDate,
            warrantyEnd: value.warrantyEnd
        },
        assignment: {
            mode: assignees.length ? 'single' : 'unassigned',
            assignees,
            pending: [], ignored: [], resolutions: [], initialized: true
        },
        observedUsers: [],
        identityConflicts: [],
        duplicateConflicts: [],
        identityResolutions: [],
        history: []
    };
    addHistory(asset, 'workstation.created', actor || 'system', 'Created manual workstation inventory record', now);
    if (assignees.length) addHistory(asset, 'assignment.manual', actor || 'system', `Assigned to ${assignees[0].display} (manual)`, now);
    return asset;
}

function peripheralInput(input) {
    input = input && typeof input === 'object' ? input : {};
    const rawSerial = text(input.serial, 128);
    const rawPurchaseDate = text(input.purchaseDate || input.purchase_date, 32);
    const rawWarrantyEnd = text(input.warrantyEnd || input.warranty_end, 32);
    const result = {
        peripheralType: normalizePeripheralType(input.peripheralType || input.type),
        name: text(input.name, 256),
        assetTag: text(input.assetTag || input.asset_tag, 128),
        serial: normalizeSerial(rawSerial),
        manufacturer: text(input.manufacturer, 256),
        model: text(input.model, 256),
        assignedUser: text(input.assignedUser || input.assigned_user, 256),
        linkedWorkstation: text(input.linkedWorkstation || input.linked_workstation, 256),
        status: text(input.status, 64),
        location: text(input.location, 256),
        purchaseDate: normalizeDate(rawPurchaseDate),
        warrantyEnd: normalizeDate(rawWarrantyEnd),
        notes: text(input.notes, 4000)
    };
    const errors = [];
    if (!result.peripheralType) errors.push(`Type must be one of: ${PERIPHERAL_TYPES.join(', ')}.`);
    if (rawSerial && !result.serial) errors.push('Serial number is a placeholder or invalid.');
    if (rawPurchaseDate && !result.purchaseDate) errors.push('Purchase date must be YYYY-MM-DD or DD/MM/YYYY.');
    if (rawWarrantyEnd && !result.warrantyEnd) errors.push('Warranty end must be YYYY-MM-DD or DD/MM/YYYY.');
    if (result.status) {
        const matchingStatus = LIFECYCLE_STATES.find((item) => item.toLowerCase() === result.status.toLowerCase());
        if (matchingStatus) result.status = matchingStatus;
        else errors.push(`Status must be one of: ${LIFECYCLE_STATES.join(', ')}.`);
    }
    if (!result.status) result.status = result.assignedUser ? 'Assigned' : 'Available';
    if (result.status === 'Assigned' && !result.assignedUser) errors.push('Assigned user is required when status is Assigned.');
    if (result.assignedUser && result.status !== 'Assigned') errors.push('Status must be Assigned when an assigned user is provided.');
    if (!result.name) result.name = [result.manufacturer, result.model].filter(Boolean).join(' ') || result.peripheralType || 'Peripheral';
    return { value: result, errors };
}

function createPeripheral(id, domain, input, actor, now, linkedWorkstation) {
    const parsed = peripheralInput(input);
    if (parsed.errors.length > 0) throw new Error(parsed.errors.join(' '));
    const value = parsed.value;
    const assignees = value.assignedUser ? [{ id: value.assignedUser.toLowerCase(), display: value.assignedUser, assignedAt: now, source: 'manual' }] : [];
    const asset = {
        _id: id,
        type: 'inventoryasset',
        domain,
        schemaVersion: 3,
        assetKind: 'peripheral',
        source: 'manual',
        createdAt: now,
        updatedAt: now,
        status: value.status,
        identity: { serial: value.serial, uuid: '' },
        nodeids: [],
        nodeid: '',
        meshName: '',
        name: value.name,
        peripheral: {
            type: value.peripheralType,
            manufacturer: value.manufacturer,
            model: value.model
        },
        links: linkedWorkstation ? {
            workstationAssetId: linkedWorkstation._id,
            workstationName: linkedWorkstation.name || '',
            workstationNodeId: linkedWorkstation.nodeid || ''
        } : {},
        automatic: {},
        manual: {
            assetTag: value.assetTag,
            location: value.location,
            notes: value.notes,
            purchaseDate: value.purchaseDate,
            warrantyEnd: value.warrantyEnd
        },
        assignment: {
            mode: assignees.length ? 'single' : 'unassigned',
            assignees,
            pending: [], ignored: [], resolutions: [], initialized: true
        },
        observedUsers: [],
        identityConflicts: [],
        identityResolutions: [],
        history: []
    };
    addHistory(asset, 'peripheral.created', actor || 'system', `Created manual ${value.peripheralType.toLowerCase()} inventory record`, now);
    return asset;
}

function applySnapshot(asset, snapshot, now, actor, conflicts, ignoredUsers) {
    const previousAutomatic = asset.automatic || {};
    asset.updatedAt = now;
    asset.nodeid = snapshot.nodeid || asset.nodeid;
    asset.meshid = snapshot.meshid || asset.meshid;
    asset.meshName = snapshot.meshName || asset.meshName;
    asset.name = snapshot.name || asset.name;
    if (!Array.isArray(asset.nodeids)) asset.nodeids = [];
    if (snapshot.nodeid && !asset.nodeids.includes(snapshot.nodeid)) {
        asset.nodeids.push(snapshot.nodeid);
        addHistory(asset, 'node.linked', actor || 'system', `Linked MeshCentral node ${snapshot.nodeid}`, now);
    }

    if (!asset.identity) asset.identity = { serial: '', uuid: '' };
    // Older plugin builds may have stored a firmware placeholder before it was
    // added to INVALID_IDENTIFIERS. Clear it so a valid fallback serial can be
    // adopted from the same agent snapshot.
    if (asset.identity.serial && !normalizeSerial(asset.identity.serial)) asset.identity.serial = '';
    if (asset.identity.uuid && !normalizeUuid(asset.identity.uuid)) asset.identity.uuid = '';
    if (!asset.identity.serial && snapshot.serial) asset.identity.serial = snapshot.serial;
    if (!asset.identity.uuid && snapshot.uuid) asset.identity.uuid = snapshot.uuid;

    asset.automatic = {
        osName: snapshot.osName,
        agentType: snapshot.agentType,
        agentVersion: snapshot.agentVersion,
        publicIp: snapshot.publicIp,
        manufacturer: snapshot.manufacturer,
        model: snapshot.model,
        assetTagReported: snapshot.assetTagReported,
        cpu: snapshot.cpu,
        memoryBytes: snapshot.memoryBytes,
        storage: snapshot.storage,
        pendingReboot: snapshot.pendingReboot,
        sysinfoTime: snapshot.sysinfoTime,
        lastConnectTime: snapshot.lastConnectTime || previousAutomatic.lastConnectTime || null,
        nodeExists: true,
        online: snapshot.online,
        lastSeen: snapshot.online ? now : (snapshot.lastConnectTime || previousAutomatic.lastSeen || snapshot.sysinfoTime || null)
    };

    if (!asset.manual) asset.manual = { assetTag: '', location: '', notes: '', purchaseDate: '', warrantyEnd: '' };
    if (!Array.isArray(asset.identityResolutions)) asset.identityResolutions = [];
    const observedConflicts = identityConflicts(asset, snapshot);
    const allConflicts = [...(Array.isArray(conflicts) ? conflicts : []), ...observedConflicts];
    const conflictKeys = new Set();
    asset.identityConflicts = allConflicts.filter((item) => {
        const key = JSON.stringify(item);
        if (conflictKeys.has(key)) return false;
        conflictKeys.add(key);
        if (asset.identityResolutions.some((resolution) => resolution.decision === 'kept' && sameConflict(resolution, item))) return false;
        return true;
    });
    if (asset.identityConflicts.length > 0) {
        const previous = JSON.stringify(asset._lastIdentityConflict || []);
        const current = JSON.stringify(asset.identityConflicts);
        if (previous !== current) {
            addHistory(asset, 'identity.conflict', actor || 'system', current, now);
            asset._lastIdentityConflict = asset.identityConflicts;
        }
    } else {
        delete asset._lastIdentityConflict;
    }

    asset.schemaVersion = 2;
    ensureAssignment(asset);
    cleanServiceAccounts(asset, now);
    applyIgnoredUsers(asset, ignoredUsers, now);
    if (snapshot.userReportAuthoritative !== false) {
        observeUsers(asset, (snapshot.reportedUsers || []).filter((user) => !ignoredUserMatches(user, ignoredUsers)), now);
    }
    return asset;
}

function identityConflictAction(asset, action, requestedConflict, actor, now) {
    if (!asset || !asset.identity) throw new Error('Asset identity is unavailable.');
    const conflict = {
        kind: text(requestedConflict && requestedConflict.kind, 64),
        expected: text(requestedConflict && requestedConflict.expected, 256),
        observed: text(requestedConflict && requestedConflict.observed, 256)
    };
    if (conflict.kind !== 'uuid-mismatch' && conflict.kind !== 'serial-mismatch') {
        throw new Error('This identity conflict cannot be resolved with this action.');
    }
    const current = (asset.identityConflicts || []).find((item) => sameConflict(item, conflict));
    if (!current) throw new Error('The identity conflict is no longer current. Synchronize and try again.');
    const field = conflict.kind === 'uuid-mismatch' ? 'uuid' : 'serial';
    const normalizedObserved = field === 'uuid' ? normalizeUuid(conflict.observed) : normalizeSerial(conflict.observed);
    if (!normalizedObserved) throw new Error('The reported identity value is invalid.');
    if (!Array.isArray(asset.identityResolutions)) asset.identityResolutions = [];

    if (action === 'accept') {
        const previous = asset.identity[field] || '';
        asset.identity[field] = normalizedObserved;
        asset.identityResolutions = asset.identityResolutions.filter((item) => item.kind !== conflict.kind);
        addHistory(asset, 'identity.accepted', actor, `Accepted reported ${field}: ${previous || 'empty'} → ${normalizedObserved}`, now);
    } else if (action === 'keep') {
        if (!asset.identityResolutions.some((item) => item.decision === 'kept' && sameConflict(item, conflict))) {
            asset.identityResolutions.push({
                kind: conflict.kind,
                expected: conflict.expected,
                observed: conflict.observed,
                decision: 'kept',
                actor: text(actor || 'system', 256),
                at: Number(now) || Date.now()
            });
        }
        if (asset.identityResolutions.length > 50) asset.identityResolutions = asset.identityResolutions.slice(-50);
        addHistory(asset, 'identity.kept', actor, `Kept stored ${field} ${conflict.expected}; dismissed reported value ${conflict.observed}`, now);
    } else {
        throw new Error('Unsupported identity action.');
    }

    asset.identityConflicts = (asset.identityConflicts || []).filter((item) => !sameConflict(item, conflict));
    if (asset.identityConflicts.length > 0) asset._lastIdentityConflict = asset.identityConflicts;
    else delete asset._lastIdentityConflict;
    asset.updatedAt = Number(now) || Date.now();
    return asset;
}

function assignmentAction(asset, action, user, actor, now) {
    const assignment = ensureAssignment(asset);
    const normalized = normalizeUser(user && (user.display || user.id));
    const id = normalized ? normalized.id : '';
    const display = normalized ? normalized.display : '';
    const pendingIndex = assignment.pending.findIndex((item) => item.id === id);
    const source = action === 'manual-replace' || (pendingIndex < 0 && !currentUserIds(asset).has(id)) ? 'manual' : 'agent';

    if (action === 'replace' || action === 'manual-replace') {
        if (!id) throw new Error('A user is required.');
        const displaced = assignment.assignees.filter((item) => item.id !== id);
        for (const previous of displaced) recordResolution(asset, previous, 'replaced', actor, now, false);
        assignment.assignees = [{ id: id, display: display, assignedAt: now, source }];
        removeResolution(asset, id);
        assignment.mode = 'single';
        assignment.initialized = true;
        if (pendingIndex >= 0) assignment.pending.splice(pendingIndex, 1);
        asset.status = 'Assigned';
        addHistory(asset, source === 'manual' ? 'assignment.manual' : 'assignment.replaced', actor, `Assigned to ${display} (${source})`, now);
    } else if (action === 'share') {
        if (!id) throw new Error('A user is required.');
        if (!assignment.assignees.some((item) => item.id === id)) {
            assignment.assignees.push({ id: id, display: display, assignedAt: now, source });
        }
        removeResolution(asset, id);
        assignment.mode = 'shared';
        assignment.initialized = true;
        if (pendingIndex >= 0) assignment.pending.splice(pendingIndex, 1);
        asset.status = 'Assigned';
        addHistory(asset, 'assignment.shared', actor, `Added shared user ${display}`, now);
    } else if (action === 'dismiss') {
        if (!id) throw new Error('A user is required.');
        if (pendingIndex >= 0) assignment.pending.splice(pendingIndex, 1);
        recordResolution(asset, { id: id, display: display }, 'dismissed', actor, now, false);
        addHistory(asset, 'assignment.dismissed', actor, `Dismissed user observation ${display}`, now);
    } else if (action === 'unassign') {
        for (const previous of assignment.assignees) recordResolution(asset, previous, 'unassigned', actor, now, false);
        assignment.assignees = [];
        assignment.mode = 'unassigned';
        assignment.initialized = true;
        if (!['In Repair', 'Retired', 'Lost/Stolen'].includes(asset.status)) asset.status = 'Available';
        addHistory(asset, 'assignment.cleared', actor, 'Cleared assignment', now);
    } else {
        throw new Error('Unsupported assignment action.');
    }
    if (assignment.assignees.length > 0 || asset.status !== 'Assigned') clearReview(asset, 'assignment-missing', now);
    asset.updatedAt = now;
    return asset;
}

function reviews(asset) {
    if (!Array.isArray(asset.reviews)) asset.reviews = [];
    return asset.reviews;
}

function addReview(asset, reason, now) {
    if (reviews(asset).some((item) => item.reason === reason)) return false;
    asset.reviews.push({ reason, createdAt: now });
    addHistory(asset, `review.${reason}`, 'synchronizer', `Review required: ${reason}`, now);
    asset.updatedAt = now;
    return true;
}

function clearReview(asset, reason, now) {
    const previous = reviews(asset).length;
    asset.reviews = asset.reviews.filter((item) => item.reason !== reason);
    if (asset.reviews.length === previous) return false;
    asset.updatedAt = now;
    return true;
}

function stalePolicy(settings, removalDays) {
    const mode = settings && settings.mode || 'meshcentral';
    const customDays = Number(settings && settings.days);
    if (mode === 'disabled') return { enabled: false, days: null, removalDays: removalDays || null, warning: false };
    const days = mode === 'custom' ? customDays : (removalDays > 0 ? Math.max(1, removalDays - 1) : 30);
    if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(days * 86400000)) throw new Error('Stale threshold must be a positive whole number of days.');
    return { enabled: true, days, removalDays: removalDays || null, warning: mode === 'custom' && removalDays > 0 && days >= removalDays };
}

function evaluateReviews(asset, policy, now) {
    if (!asset || asset.assetKind !== 'workstation') return false;
    let changed = false;
    const assignment = ensureAssignment(asset);
    if (asset.status === 'Assigned' && assignment.assignees.length === 0) changed = addReview(asset, 'assignment-missing', now) || changed;
    else changed = clearReview(asset, 'assignment-missing', now) || changed;
    if (asset.source === 'manual') return changed;

    const automatic = asset.automatic || {};
    const lastSeen = Number(automatic.lastSeen);
    const stale = Boolean(policy && policy.enabled && lastSeen > 0 && now - lastSeen >= policy.days * 86400000);
    const condition = automatic.online === true ? 'Online' : automatic.nodeExists === false ? 'Node missing' : stale ? 'Stale' : 'Offline';
    if (automatic.condition !== condition) { automatic.condition = condition; changed = true; }
    const presence = asset.presence || (asset.presence = {});
    if (automatic.online === true) {
        if (presence.wasOnline !== true) { presence.wasOnline = true; changed = true; }
        if (presence.acknowledgedReason) { delete presence.acknowledgedReason; changed = true; }
        changed = clearReview(asset, 'stale-device', now) || changed;
        changed = clearReview(asset, 'node-missing', now) || changed;
        if (asset.recordState === 'Archived') changed = addReview(asset, 'archived-returned', now) || changed;
    } else {
        if (presence.wasOnline !== false) { presence.wasOnline = false; changed = true; }
        changed = clearReview(asset, 'archived-returned', now) || changed;
        if (asset.recordState === 'Archived') {
            changed = clearReview(asset, 'stale-device', now) || changed;
            changed = clearReview(asset, 'node-missing', now) || changed;
        } else if (automatic.nodeExists === false) {
            changed = clearReview(asset, 'stale-device', now) || changed;
            if (presence.acknowledgedReason === 'node-missing') changed = clearReview(asset, 'node-missing', now) || changed;
            else changed = addReview(asset, 'node-missing', now) || changed;
        } else {
            changed = clearReview(asset, 'node-missing', now) || changed;
            if (stale && !presence.acknowledgedReason) {
                changed = addReview(asset, 'stale-device', now) || changed;
            } else changed = clearReview(asset, 'stale-device', now) || changed;
        }
    }
    if (changed) asset.updatedAt = now;
    return changed;
}

function reviewAction(asset, action, reason, until, actor, now) {
    if (action === 'restore') {
        if (asset.recordState !== 'Archived') throw new Error('The record is not archived.');
        asset.recordState = 'Active';
        clearReview(asset, 'archived-returned', now);
    } else if (action === 'archive') {
        if (!['stale-device', 'node-missing'].includes(reason) || !reviews(asset).some((item) => item.reason === reason)) throw new Error('Review is no longer current.');
        asset.recordState = 'Archived';
        clearReview(asset, 'stale-device', now);
        clearReview(asset, 'node-missing', now);
        clearReview(asset, 'archived-returned', now);
    } else if (action === 'retire') {
        if (!['stale-device', 'node-missing'].includes(reason) || !reviews(asset).some((item) => item.reason === reason)) throw new Error('Review is no longer current.');
        asset.status = 'Retired';
        asset.presence = asset.presence || {};
        asset.presence.acknowledgedReason = reason;
        clearReview(asset, 'stale-device', now);
        clearReview(asset, 'node-missing', now);
    } else if (action === 'acknowledge') {
        if (!['stale-device', 'node-missing'].includes(reason) || !reviews(asset).some((item) => item.reason === reason)) throw new Error('Review is no longer current.');
        asset.presence = asset.presence || {};
        asset.presence.acknowledgedReason = reason;
        clearReview(asset, reason, now);
    } else if (action === 'snooze') {
        if (!['stale-device', 'node-missing'].includes(reason)) throw new Error('This review cannot be snoozed.');
        const review = reviews(asset).find((item) => item.reason === reason);
        const date = normalizeDate(until);
        if (!review || !date || Date.parse(`${date}T23:59:59Z`) <= now) throw new Error('A future snooze date is required.');
        review.snoozedUntil = date;
    } else throw new Error('Unsupported review action.');
    asset.updatedAt = now;
    addHistory(asset, `review.${action}`, actor, `${reason || 'record'}${action === 'snooze' ? ` until ${until}` : ''}`, now);
    return asset;
}

module.exports = {
    LIFECYCLE_STATES,
    PERIPHERAL_TYPES,
    normalizeUuid,
    normalizeSerial,
    normalizePeripheralType,
    normalizeDate,
    normalizeUser,
    reportedUsers,
    snapshotFrom,
    identityConflicts,
    selectAsset,
    addHistory,
    observeUsers,
    createAsset,
    workstationInput,
    createManualWorkstation,
    peripheralInput,
    createPeripheral,
    applySnapshot,
    applyIgnoredUsers,
    ignoredUserMatches,
    normalizeIgnoredUsers,
    identityConflictAction,
    assignmentAction,
    stalePolicy,
    evaluateReviews,
    reviewAction,
    text
};
