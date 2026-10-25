import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeProfile} from '../image/native-source/profiles.mjs';

test('default profile retains the reviewed immutable host', () => {
  const profile = loadNativeProfile();
  assert.equal(profile.profileId, 'open-design-w2.4');
  assert.match(profile.baseImage, /@sha256:5252ac5b3d97b094f3093619ac7eab8003455c817687f9d474f3bf9e26f9e5ce$/);
  assert.equal(profile.files.length, 3);
});

test('Omnigent profile records its actual host and retains only the reviewed MCP replacements', () => {
  const base = loadNativeProfile();
  const profile = loadNativeProfile('omnigent-0.1.4');
  assert.match(profile.baseImage, /@sha256:e6d4e1aa6314b5d6cab052a630b9388360fb4710c517b056c17aa24932601b3a$/);
  assert.equal(profile.hostSource.commit, 'f95a85bcd534c3b981b0a9a494b0c92f9dca480d');
  assert.deepEqual(profile.files, base.files);
  assert.deepEqual(profile.nativeSource, base.nativeSource);
  assert.deepEqual(profile.files.map(file => file.target), [
    'app/apps/daemon/dist/mcp-config.js',
    'app/apps/daemon/dist/mcp-routes.js',
    'app/apps/daemon/dist/routes/mcp-servers.js',
  ]);
});

test('unknown profiles and paths fail closed before building', () => {
  for (const id of ['', '../profile.json', '/tmp/profile.json', 'latest', 'omnigent']) {
    assert.throws(() => loadNativeProfile(id), /unsupported native image profile/);
  }
});

test('mobile Omnigent host changes only the reviewed web layer', () => {
  const profile = loadNativeProfile('omnigent-0.1.4-mobile');
  assert.match(profile.baseImage, /@sha256:c9ce744b583686ec717c60f66cb4d9844dd983c9658354f9af54384c6c75cc5b$/);
  assert.equal(profile.hostSource.baseCommit, loadNativeProfile('omnigent-0.1.4').hostSource.commit);
  assert.equal(profile.hostSource.commit, '721f80835646d4d53ffc9e9d898aa54c965e3b64');
  assert.deepEqual(profile.files, loadNativeProfile().files);
});

test('mobile w2.4 host preserves the original host family', () => {
  const profile = loadNativeProfile('open-design-w2.4-mobile');
  assert.match(profile.baseImage, /@sha256:efc4b40bb1186cd9e81b9f590a58d0bee385cd99fd6a5830e75914c3044d3cd4$/);
  assert.equal(profile.hostSource.baseCommit, loadNativeProfile().nativeSource.featureCommit);
  assert.equal(profile.hostSource.commit, '2fef8017bba43aac3b94ffadbb8da15678016e83');
  assert.deepEqual(profile.files, loadNativeProfile().files);
});
