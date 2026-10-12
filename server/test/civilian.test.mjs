import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const base = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, base), 'utf8');

test('aircraft menus and flight planner use exactly the shipped civilian models', async () => {
  const expected = ['airliner', 'c172', 'glider'];
  const models = (await readdir(new URL('bevy/assets/models/', base))).filter(f => f.endsWith('.glb')).map(f => f.slice(0, -4)).sort();
  assert.deepEqual(models, expected);
  for (const [file, name] of [['ui.js', 'ASSETS'], ['flight.js', 'AIRCRAFT']]) {
    const source = await read(`bevy/${file}`);
    const literal = source.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n  \\]);`))[1];
    const ids = [...vm.runInNewContext(literal)].map(a => a.id).sort();
    assert.deepEqual(ids, expected);
  }
  const catalog = await read('bevy/src/catalog.rs');
  const literal = catalog.match(/pub static ASSETS:[\s\S]*?= \[([\s\S]*?)\n\];/)[1];
  assert.deepEqual([...literal.matchAll(/asset\("([^"]+)"/g)].map(m => m[1]).sort(), expected);
  for (const id of expected) assert.ok((await readFile(new URL(`bevy/assets/thumbs/${id}.png`, base))).length > 0);
});

test('the served interface matches the current source', async () => {
  const index = await read('prebuilt/index.html');
  assert.match(index, /<title>Flight Simulator<\/title>/);
  const html = await read('bevy/index.html');
  for (const [, path] of html.matchAll(/<link data-trunk rel="copy-file" href="([^"]+)"/g)) {
    const source = new URL(path, new URL('bevy/', base));
    assert.deepEqual(await readFile(source), await readFile(new URL(`prebuilt/${path.split('/').at(-1)}`, base)), path);
  }
});
