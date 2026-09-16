const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/login.js'), 'utf8');

function makeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); },
  };
}

function setup() {
  const elements = new Map();
  const animationFrames = [];
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;

  function element(id) {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, {
        id,
        hidden: id === 'workerPanel' || id === 'adminPanel',
        classList: makeClassList(),
        listeners,
        addEventListener(type, listener) { listeners[type] = listener; },
        focus(options) { this.focusOptions = options; this.focusCount = (this.focusCount || 0) + 1; },
        reset() {},
        replaceChildren() {},
        querySelector() { return element(`${id}-child`); },
        scrollIntoView(options) {
          this.scrollOptions = options;
          this.scrollCount = (this.scrollCount || 0) + 1;
        },
      });
    }
    return elements.get(id);
  }

  function setTimer(callback, delay = 0) {
    const id = nextTimerId++;
    timers.set(id, { callback, at: now + delay });
    return id;
  }

  function clearTimer(id) {
    timers.delete(id);
  }

  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = target;
  }

  const document = {
    getElementById: element,
    createElement: tag => element(`created-${tag}`),
    querySelector() { return { value: 'pin' }; },
  };
  const window = {
    clearTimeout: clearTimer,
    setTimeout: setTimer,
    matchMedia(query) {
      return { matches: query === '(max-width: 820px)' };
    },
    location: { href: '' },
  };
  const context = vm.createContext({
    document,
    window,
    clearTimeout: clearTimer,
    requestAnimationFrame(callback) { animationFrames.push(callback); },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    sessionStorage: { setItem() {} },
  });
  vm.runInContext(source, context);

  return {
    advance,
    element,
    flushAnimationFrames() {
      while (animationFrames.length) animationFrames.shift()();
    },
  };
}

for (const scenario of [
  { choice: 'adminChoice', panel: 'adminPanel', control: 'username' },
  { choice: 'workerChoice', panel: 'workerPanel', control: 'workerPhone' },
]) {
  test(`${scenario.choice} scrolls its mobile login fields into view after expansion`, () => {
    const page = setup();
    page.element(scenario.choice).listeners.click();
    page.flushAnimationFrames();

    page.advance(229);
    assert.equal(page.element(scenario.panel).scrollCount || 0, 0);

    page.advance(1);
    assert.equal(page.element(scenario.panel).scrollCount, 1);
    assert.deepEqual(
      { ...page.element(scenario.panel).scrollOptions },
      { block: 'start', inline: 'nearest', behavior: 'smooth' },
    );

    page.advance(260);
    assert.equal(page.element(scenario.control).focusCount, 1);
    assert.equal(page.element(scenario.control).focusOptions.preventScroll, true);
  });
}
