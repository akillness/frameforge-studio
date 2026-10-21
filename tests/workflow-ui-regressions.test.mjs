import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowEditor } from '../public/workflow.js';

async function editorFixture() {
  const previousDocument = globalThis.document;
  const listeners = new Map();
  const host = {
    dataset: {},
    isConnected: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  globalThis.document = { querySelector: () => host };
  const workflow = { id: 'workflow-fixture', version: 1, name: 'Original name', nodes: [], edges: [] };
  const editor = createWorkflowEditor({ api: async path => path === '/api/workflows' ? [workflow] : [] });
  await editor.load();
  editor.mount();
  return {
    editor,
    host,
    listeners,
    restore() {
      editor.destroy();
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

test('workflow name inputs with an empty data attribute still mark the workflow dirty', async () => {
  const fixture = await editorFixture();
  try {
    fixture.listeners.get('input')({ target: {
      id: 'workflow-name-dialog-input',
      dataset: { workflowName: '' },
      hasAttribute: name => name === 'data-workflow-name',
      value: 'Renamed workflow',
    } });
    assert.equal(fixture.editor.hasChanges(), true);
  } finally {
    fixture.restore();
  }
});

test('stacked workflow wheel events retain native page scrolling', async () => {
  const fixture = await editorFixture();
  try {
    const canvas = { dataset: { layout: 'stacked' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    let prevented = false;
    fixture.listeners.get('wheel')({
      target: { closest: selector => selector === '#workflow-canvas' ? canvas : null },
      preventDefault() { prevented = true; },
      deltaY: 100,
      clientX: 20,
      clientY: 30,
    });
    assert.equal(prevented, false);
  } finally {
    fixture.restore();
  }
});

test('workflow history navigation opens the disclosure and transfers keyboard focus without editing', async () => {
  const fixture = await editorFixture();
  try {
    const events = [];
    const summary = { focus: options => events.push(['focus', options]) };
    const section = { tagName: 'DETAILS', open: false, scrollIntoView: options => events.push(['scroll', options]), querySelector: selector => selector === 'summary' ? summary : null };
    fixture.host.querySelector = selector => selector === '#wf-run-history' ? section : null;
    const link = { getAttribute: name => name === 'href' ? '#wf-run-history' : null };
    let prevented = false;
    fixture.listeners.get('click')({ preventDefault() { prevented = true; }, target: { closest: selector => selector === '[data-wf-section]' ? link : null } });
    assert.equal(prevented, true);
    assert.equal(section.open, true);
    assert.deepEqual(events, [['scroll', { block: 'start' }], ['focus', { preventScroll: true }]]);
    assert.equal(fixture.editor.hasChanges(), false);
  } finally {
    fixture.restore();
  }
});

test('workflow design navigation focuses the canvas rather than searching for a disclosure summary', async () => {
  const fixture = await editorFixture();
  try {
    let focused = false;
    const canvas = { tagName: 'DIV', scrollIntoView() {}, focus() { focused = true; } };
    fixture.host.querySelector = selector => selector === '#workflow-canvas' ? canvas : null;
    const link = { getAttribute: () => '#workflow-canvas' };
    fixture.listeners.get('click')({ preventDefault() {}, target: { closest: selector => selector === '[data-wf-section]' ? link : null } });
    assert.equal(focused, true);
    assert.equal(fixture.editor.hasChanges(), false);
  } finally {
    fixture.restore();
  }
});

test('workflow section navigation tolerates a target removed during rerender', async () => {
  const fixture = await editorFixture();
  try {
    const link = { getAttribute: () => '#wf-review' };
    assert.doesNotThrow(() => fixture.listeners.get('click')({ preventDefault() {}, target: { closest: selector => selector === '[data-wf-section]' ? link : null } }));
    assert.equal(fixture.editor.hasChanges(), false);
  } finally {
    fixture.restore();
  }
});
