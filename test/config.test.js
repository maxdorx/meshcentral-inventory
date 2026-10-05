'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manifest has the fields required by the MeshCentral 1.2.5 and 1.2.6 plugin loader', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
    for (const field of ['name', 'shortName', 'version', 'description', 'homepage', 'changelogUrl', 'configUrl', 'meshCentralCompat']) {
        assert.equal(typeof config[field], 'string', field);
        assert.ok(config[field].length > 0, field);
    }
    assert.equal(config.shortName, 'inventory');
    assert.equal(config.name, 'Inventory');
    assert.equal(config.version, '1.0.1');
    assert.equal(config.hasAdminPanel, true);
    assert.equal(config.repository.type, 'git');
    assert.equal(typeof config.repository.url, 'string');
    assert.equal(typeof config.downloadUrl, 'string');
    assert.equal(config.configUrl, 'https://raw.githubusercontent.com/maxdorx/meshcentral-inventory/main/config.json');
    assert.equal(config.downloadUrl, 'https://github.com/maxdorx/meshcentral-inventory/releases/latest/download/MeshCentral-Inventory.zip');
    assert.equal(config.versionHistoryUrl, undefined);
    assert.equal(config.meshCentralCompat, '>=1.2.5');
});
