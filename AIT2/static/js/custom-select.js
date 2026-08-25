(function () {
  'use strict';

  let active = null;
  let menu = null;

  function viewportCoordinates() {
    if (window.showbaseViewport) return window.showbaseViewport;
    const value = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
    );
    const scale = Number.isFinite(value) && value > 0 ? value : 1;
    return {
      rect(rect) {
        return {
          top: rect.top / scale,
          right: rect.right / scale,
          bottom: rect.bottom / scale,
          left: rect.left / scale,
          width: rect.width / scale,
          height: rect.height / scale
        };
      },
      width: () => window.innerWidth / scale,
      height: () => window.innerHeight / scale
    };
  }

  function eligible(select) {
    return select instanceof HTMLSelectElement
      && !select.multiple
      && Number(select.size || 0) <= 1
      && !select.classList.contains('sr-only')
      && select.getAttribute('aria-hidden') !== 'true'
      && !select.hasAttribute('data-native-select');
  }

  function selectedLabel(select) {
    const option = select.selectedOptions?.[0];
    return option?.textContent?.trim() || select.getAttribute('placeholder') || 'Choose an option';
  }

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'showbaseSelectMenu';
    menu.className = 'sb-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    document.body.appendChild(menu);
    menu.addEventListener('click', event => {
      const optionButton = event.target.closest('[data-sb-option-index]');
      if (!optionButton || !active) return;
      const option = active.select.options[Number(optionButton.dataset.sbOptionIndex)];
      if (!option || option.disabled) return;
      active.select.value = option.value;
      active.select.dispatchEvent(new Event('input', { bubbles: true }));
      active.select.dispatchEvent(new Event('change', { bubbles: true }));
      sync(active.select);
      close(true);
    });
    menu.addEventListener('keydown', event => {
      const choices = [...menu.querySelectorAll('[data-sb-option-index]:not(:disabled)')];
      const current = choices.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        choices[(current + step + choices.length) % choices.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        choices[event.key === 'Home' ? 0 : choices.length - 1]?.focus();
      } else if (event.key === 'Tab') {
        close(false);
      }
    });
    return menu;
  }

  function renderMenu(select) {
    const fragment = document.createDocumentFragment();
    [...select.children].forEach(child => {
      if (child instanceof HTMLOptGroupElement) {
        const label = document.createElement('div');
        label.className = 'sb-select-group';
        label.textContent = child.label;
        fragment.appendChild(label);
        [...child.children].forEach(option => fragment.appendChild(optionButton(select, option)));
      } else if (child instanceof HTMLOptionElement) {
        fragment.appendChild(optionButton(select, child));
      }
    });
    menu.replaceChildren(fragment);
    menu.setAttribute('aria-label', select.getAttribute('aria-label') || select.name || 'Options');
  }

  function optionButton(select, option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-select-option';
    button.dataset.sbOptionIndex = String([...select.options].indexOf(option));
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(option.selected));
    button.disabled = option.disabled;
    if (option.hidden) button.hidden = true;
    if (option.selected) button.classList.add('is-selected');
    const label = document.createElement('span');
    label.textContent = option.textContent.trim();
    const check = document.createElement('span');
    check.className = 'sb-select-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = option.selected ? '✓' : '';
    button.append(label, check);
    return button;
  }

  function positionMenu() {
    if (!active || menu.hidden) return;
    const viewport = viewportCoordinates();
    const rect = viewport.rect(active.button.getBoundingClientRect());
    const viewportWidth = viewport.width();
    const viewportHeight = viewport.height();
    const gap = 5;
    const width = Math.max(rect.width, 180);
    menu.style.width = `${Math.min(width, viewportWidth - 16)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - menu.offsetWidth - 8))}px`;
    const below = viewportHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const openAbove = below < Math.min(260, menu.scrollHeight) && above > below;
    menu.style.maxHeight = `${Math.max(120, Math.min(320, openAbove ? above : below))}px`;
    menu.style.top = openAbove
      ? `${Math.max(8, rect.top - menu.offsetHeight - gap)}px`
      : `${rect.bottom + gap}px`;
  }

  function open(select) {
    const wrapper = select.closest('.sb-select');
    const button = wrapper?.querySelector('.sb-select-button');
    if (!button || select.disabled) return;
    if (active?.select === select && !menu.hidden) {
      close(true);
      return;
    }
    close(false);
    ensureMenu();
    active = { select, wrapper, button };
    renderMenu(select);
    menu.hidden = false;
    wrapper.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    positionMenu();
    requestAnimationFrame(() => {
      positionMenu();
      menu.querySelector('.is-selected:not(:disabled), .sb-select-option:not(:disabled)')?.focus();
    });
  }

  function close(refocus) {
    if (!active) return;
    const previous = active;
    previous.wrapper.classList.remove('is-open');
    previous.button.setAttribute('aria-expanded', 'false');
    active = null;
    if (menu) menu.hidden = true;
    if (refocus && previous.button.isConnected) previous.button.focus();
  }

  function sync(select) {
    const wrapper = select.closest('.sb-select');
    const button = wrapper?.querySelector('.sb-select-button');
    if (!button) return;
    const label = selectedLabel(select);
    if (button.querySelector('.sb-select-value')?.textContent !== label) {
      button.querySelector('.sb-select-value').textContent = label;
    }
    button.disabled = select.disabled;
    wrapper.classList.toggle('is-disabled', select.disabled);
    wrapper.classList.toggle('has-value', Boolean(select.value));
    button.setAttribute('aria-invalid', String(select.matches(':invalid')));
  }

  function enhance(select) {
    if (!eligible(select) || select.closest('.sb-select')) return;
    const wrapper = document.createElement('span');
    wrapper.className = 'sb-select';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-select-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'showbaseSelectMenu');
    button.innerHTML = '<span class="sb-select-value"></span><span class="sb-select-chevron" aria-hidden="true"></span>';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(select, button);
    ['width', 'minWidth', 'maxWidth', 'flex', 'alignSelf'].forEach(property => {
      if (select.style[property]) wrapper.style[property] = select.style[property];
    });
    select.classList.add('sb-select-native');
    select.dataset.sbSelectEnhanced = 'true';
    select.tabIndex = -1;
    button.addEventListener('click', () => open(select));
    button.addEventListener('keydown', event => {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        open(select);
      }
    });
    select.addEventListener('change', () => sync(select));
    select.addEventListener('invalid', event => {
      event.preventDefault();
      sync(select);
      button.focus();
    });
    sync(select);
  }

  function enhanceWithin(root) {
    if (root instanceof HTMLSelectElement) enhance(root);
    root.querySelectorAll?.('select').forEach(enhance);
  }

  document.addEventListener('click', event => {
    if (!active) return;
    if (active.wrapper.contains(event.target) || menu?.contains(event.target)) return;
    close(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) close(true);
  });
  window.addEventListener('resize', positionMenu);
  document.addEventListener('scroll', positionMenu, true);

  const start = () => {
    ensureMenu();
    enhanceWithin(document);
    new MutationObserver(mutations => {
      mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceWithin(node);
      }));
    }).observe(document.body, { childList: true, subtree: true });
    window.setInterval(() => {
      document.querySelectorAll('select[data-sb-select-enhanced="true"]').forEach(sync);
    }, 400);
  };

  window.refreshShowbaseSelect = select => {
    if (select) {
      enhance(select);
      sync(select);
    } else {
      enhanceWithin(document);
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
