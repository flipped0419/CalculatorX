import test from 'node:test';
import assert from 'node:assert/strict';

import { CasWorksheetSession } from '../entry/src/main/ets/utils/cas/CasWorksheetSession.ts';

const echo = async (latex) => latex;

test('multiple rows preserve inputs and allow dynamic references to previous output', async () => {
  const session = new CasWorksheetSession();
  session.addRow('2');
  session.addRow('$1+3');
  let rows = await session.recalculate(echo);
  assert.equal(rows[1].evaluationLatex, '\\left(2\\right)+3');
  assert.equal(rows[1].status, 'ready');
  session.updateRow(1, '5');
  rows = await session.recalculate(echo);
  assert.equal(rows[1].evaluationLatex, '\\left(5\\right)+3');
  assert.equal(rows[1].inputLatex, '$1+3');
});

test('static #n reference freezes the source output', async () => {
  const session = new CasWorksheetSession();
  session.addRow('2');
  await session.recalculate(echo);
  session.addRow('#1+7');
  session.updateRow(1, '100');
  const rows = await session.recalculate(echo);
  assert.equal(rows[1].evaluationLatex, '\\left(2\\right)+7');
  assert.equal(rows[1].inputLatex, '#1+7');
});

test('independent rows still evaluate when a referenced row fails', async () => {
  const session = new CasWorksheetSession();
  session.addRow('$2');
  session.addRow('$1');
  session.addRow('8');
  const rows = await session.recalculate(echo);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[1].status, 'error');
  assert.match(rows[0].errorMessage, /循环引用/);
  assert.equal(rows[2].status, 'ready');
  assert.equal(rows[2].outputLatex, '8');
});

test('deleted rows do not cause existing references to silently rebind', async () => {
  const session = new CasWorksheetSession();
  session.addRow('1');
  session.addRow('2');
  session.addRow('$1');
  session.deleteRow(1);
  session.addRow('3');
  const rows = await session.recalculate(echo);
  assert.deepEqual(rows.map((row) => row.id), [2, 3, 4]);
  assert.equal(rows[1].status, 'error');
  assert.match(rows[1].errorMessage, /不存在/);
});

test('forward references can resolve after the source row is added', async () => {
  const session = new CasWorksheetSession();
  session.addRow('$2');
  session.addRow('4');
  const rows = await session.recalculate(echo);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].evaluationLatex, '\\left(4\\right)');
});

test('frozen references do not awaken after a missing source is later added', async () => {
  const session = new CasWorksheetSession();
  session.addRow('#2');
  session.addRow('2');
  const rows = await session.recalculate(echo);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].errorMessage, /尚无可复制/);
});

test('snapshot round-trip retains stable IDs and frozen dependencies', async () => {
  const original = new CasWorksheetSession();
  original.addRow('7');
  await original.recalculate(echo);
  original.addRow('#1 + $1');
  const saved = original.exportSnapshot();
  const restored = new CasWorksheetSession();
  restored.loadSnapshot(saved);
  restored.updateRow(1, '9');
  const rows = await restored.recalculate(echo);
  assert.equal(rows[1].evaluationLatex, '\\left(7\\right) + \\left(9\\right)');
  assert.equal(restored.addRow(''), 3);
});

test('outdated asynchronous calculations do not overwrite edits', async () => {
  const session = new CasWorksheetSession();
  session.addRow('old');
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const calculation = session.recalculate(async (latex) => {
    await waiting;
    return latex;
  });
  session.updateRow(1, 'new');
  finish();
  await calculation;
  let rows = session.getRows();
  assert.equal(rows[0].inputLatex, 'new');
  assert.equal(rows[0].outputLatex, '');
  rows = await session.recalculate(echo);
  assert.equal(rows[0].outputLatex, 'new');
});

test('input guard, escaped references, empty rows and row cap', async () => {
  const session = new CasWorksheetSession();
  assert.throws(() => session.addRow('a'.repeat(8193)), /长度/);
  session.addRow('\\#1');
  session.addRow('');
  const rows = await session.recalculate(echo);
  assert.equal(rows[0].outputLatex, '\\#1');
  assert.equal(rows[1].status, 'empty');
  for (let i = 2; i < 100; i += 1) {
    session.addRow('1');
  }
  assert.throws(() => session.addRow('1'), /最多/);
});

test('snapshot rejects malformed rows', () => {
  const session = new CasWorksheetSession();
  assert.throws(() => session.loadSnapshot({
    version: 1,
    nextRowId: 3,
    rows: [{ id: 1, inputLatex: 'x', frozenLatex: 'x', freezeError: '' },
      { id: 1, inputLatex: 'y', frozenLatex: 'y', freezeError: '' }]
  }), /无效/);
});

test('50 chained rows calculate without recomputing dependencies', async () => {
  const session = new CasWorksheetSession();
  session.addRow('1');
  for (let id = 2; id <= 50; id += 1) {
    session.addRow('$' + (id - 1) + '+1');
  }
  let calls = 0;
  const rows = await session.recalculate(async (latex) => { calls += 1; return latex; });
  assert.equal(rows.length, 50);
  assert.equal(calls, 50);
  assert.equal(rows[49].status, 'ready');
});
