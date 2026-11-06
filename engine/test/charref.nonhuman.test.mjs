// Animal / creature / cartoon characters keep their reference photos even though the face grader
// (built for people) flags them "no-face" with a near-zero score. Run: node --test engine/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRefs, planRefs } from '../lib/charref.js';

const HASH = { a1: 'ffff0000ffff0000', a2: '0000ffff0000ffff', a3: 'f0f0f0f00f0f0f0f', b1: '0f0f0f0ff0f0f0f0' };
const ref = (id, sharp, extra = {}) => ({ assetId: id, kind: 'photo', status: 'ready', hash: HASH[id], quality: { score: 3, sharp, flags: ['no-face'] }, framing: 'full-body', angle: 'front', expression: 'other', ...extra });
const dog = { name: 'Big Dog', realPerson: false, refs: [ref('a1', 0.9), ref('a2', 0.5), ref('a3', 0.95)] };

test('a non-human character keeps its "no-face" photos, sharpest first', () => {
  const picked = pickRefs(dog, 6).map((r) => r.assetId);
  assert.deepEqual(picked, ['a3', 'a1', 'a2']);
  const plan = planRefs([dog], { limit: 4, tag: 'xai' });
  assert.equal(plan.refs.length, 3);
  assert.match(plan.guide, /Big Dog/);
});

test('real people still drop photos with no visible face', () => {
  const person = { ...dog, name: 'Pat', realPerson: true };
  assert.equal(pickRefs(person, 6).length, 0);
  const withFace = { ...person, refs: [...person.refs, { ...ref('b1', 0.8), quality: { score: 80, sharp: 0.8, flags: [] } }] };
  assert.deepEqual(pickRefs(withFace, 6).map((r) => r.assetId), ['b1']);
});
