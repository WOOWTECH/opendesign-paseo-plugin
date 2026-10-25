import fs from 'node:fs';
import assert from 'node:assert/strict';

export function loadNativeProfile(id = 'open-design-w2.4') {
  const profile = JSON.parse(fs.readFileSync(new URL('./profile.json', import.meta.url)));
  if (['omnigent-0.1.5', 'omnigent-0.1.4', 'omnigent-0.1.4-mobile', 'open-design-w2.4-mobile'].includes(id)) {
    const host = JSON.parse(fs.readFileSync(new URL(`./${id}.json`, import.meta.url)));
    Object.assign(profile, host);
  } else {
    assert.equal(id, 'open-design-w2.4', 'unsupported native image profile');
  }
  assert.match(profile.baseImage, /@sha256:[a-f0-9]{64}$/);
  return { ...profile, profileId: id };
}
