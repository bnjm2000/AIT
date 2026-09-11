const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');

function classList(...initial) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); },
  };
}

function setup() {
  const body = {
    appendChild(node) {
      node.parentElement = body;
      node.parentNode = body;
    },
  };
  const origin = {
    isConnected: true,
    insertBefore(node, sibling) {
      this.restoredBefore = sibling;
      node.parentElement = this;
      node.parentNode = this;
    },
  };
  const nextSibling = { parentNode: origin };
  const scrollContainer = {};
  const control = {
    getBoundingClientRect() {
      return { top: 500, right: 690, bottom: 524, left: 620, width: 70, height: 24 };
    },
  };
  const menu = {
    classList: classList('finance-custom-menu', 'finance-uom-menu'),
    dataset: {},
    style: {},
    parentElement: origin,
    parentNode: origin,
    nextSibling,
    closest(selector) {
      if (selector === '.finance-lines-scroll') return scrollContainer;
      if (selector === '.finance-custom-control') return control;
      return null;
    },
    getBoundingClientRect() {
      return { top: 0, right: 725, bottom: 140, left: 620, width: 105, height: 140 };
    },
    remove() { this.removed = true; },
  };
  const document = {
    body,
    addEventListener() {},
    getElementById(id) { return id === 'uom-menu' ? menu : null; },
    querySelectorAll(selector) {
      if (!selector.includes('.finance-custom-menu')) return [];
      return menu.classList.contains('open') || menu.dataset.financeMenuPortal
        ? [menu]
        : [];
    },
  };
  const context = vm.createContext({
    document,
    window: { innerWidth: 1000, innerHeight: 700 },
    showbaseViewport: {
      rect: rect => rect,
      width: () => 1000,
      height: () => 700,
    },
    showbaseLineWorkspace: { createSubprojectController() { return {}; } },
    clearTimeout,
    setTimeout,
  });
  vm.runInContext(source, context);
  return { context, menu, origin, nextSibling, control };
}

test('UOM menu escapes the short line-table scroller and is restored on close', () => {
  const { context, menu, origin, nextSibling, control } = setup();
  const event = {
    currentTarget: control,
    stopPropagation() {},
  };
  context.menuToggleEvent = event;

  vm.runInContext("financeToggleMenu('uom-menu', menuToggleEvent)", context);

  assert.equal(menu.classList.contains('open'), true);
  assert.equal(menu.parentElement, context.document.body);
  assert.equal(menu.dataset.financeMenuPortal, 'true');
  assert.equal(menu.style.position, 'fixed');
  assert.equal(menu.style.top, '529px');
  assert.equal(menu.style.left, '620px');
  assert.equal(menu.style.maxHeight, '163px');

  vm.runInContext('financeCloseMenus()', context);

  assert.equal(menu.classList.contains('open'), false);
  assert.equal(menu.parentElement, origin);
  assert.equal(origin.restoredBefore, nextSibling);
  assert.equal(menu.dataset.financeMenuPortal, undefined);
  assert.equal(menu.style.position, '');
  assert.equal(menu.style.top, '');
});
