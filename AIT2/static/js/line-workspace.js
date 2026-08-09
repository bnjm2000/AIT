(function initialiseShowbaseLineWorkspace(global) {
  function escapeAttribute(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function numberValue(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function reorderAtIndex(rows, sourceId, targetIndex) {
    const sourceIndex = rows.findIndex(row => String(row.id) === String(sourceId));
    if (sourceIndex < 0) return null;
    const reordered = [...rows];
    const [source] = reordered.splice(sourceIndex, 1);
    let insertionIndex = Math.max(0, Math.min(Number(targetIndex) || 0, rows.length));
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    if (insertionIndex === sourceIndex) return null;
    reordered.splice(insertionIndex, 0, source);
    return reordered;
  }

  function reorderRelative(rows, sourceId, targetId, position = 'before') {
    const source = rows.find(row => String(row.id) === String(sourceId));
    const target = rows.find(row => String(row.id) === String(targetId));
    if (!source || !target || source === target) return null;
    const reordered = rows.filter(row => row !== source);
    const targetIndex = reordered.indexOf(target);
    reordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source);
    return reordered.every((row, index) => row === rows[index]) ? null : reordered;
  }

  // Shared quotation/costing workspace mechanics; each editor owns its data columns and calculations.
  global.showbaseLineWorkspace = {
    addRowMarkup(options = {}) {
      const search = options.search || {};
      const category = options.category || {};
      const extraMarkup = String(options.extraMarkup || '');
      const optionalAttribute = (name, value) => (
        value ? ` ${name}="${escapeAttribute(value)}"` : ''
      );
      return `<div class="finance-add-row finance-add-row-expanded showbase-line-workspace-add-row ${escapeAttribute(options.className || '')}">
        <div class="finance-add-item-wrap ${escapeAttribute(search.wrapClass || '')}">
          <input id="${escapeAttribute(search.id || '')}" class="finance-input" placeholder="${escapeAttribute(search.placeholder || '')}" autocomplete="off"${optionalAttribute('oninput', search.oninput)}${optionalAttribute('onkeydown', search.onkeydown)}>
          <div id="${escapeAttribute(search.resultsId || '')}" class="finance-catalog-results"></div>
        </div>
        <div class="finance-inline-combobox">
          <input id="${escapeAttribute(category.id || '')}" class="finance-input" value="${escapeAttribute(category.value || '')}" placeholder="${escapeAttribute(category.placeholder || 'Category')}" autocomplete="off"${optionalAttribute('oninput', category.oninput)}${optionalAttribute('onfocus', category.onfocus)}${optionalAttribute('onblur', category.onblur)}${optionalAttribute('onkeydown', category.onkeydown)}>
          <div class="finance-inline-suggestions" id="${escapeAttribute(category.resultsId || '')}"></div>
        </div>
        ${extraMarkup}
        <button type="button" class="btn btn-primary" onclick="${escapeAttribute(options.addAction || '')}">+ Add</button>
        ${options.showGroup === false ? '' : `<button type="button" class="btn btn-secondary finance-add-group-button" onclick="${escapeAttribute(options.groupAction || `financeOpenLineGroupEditor('${options.mode || 'finance'}')`)}">+ Group</button>`}
      </div>`;
    },

    beginDrag(state, event, lines, indexes, options = {}) {
      const parseNumber = options.numberValue || numberValue;
      const selected = [...new Set((indexes || []).map(value => parseNumber(value, -1)))]
        .filter(index => index >= 0 && !!lines[index] && (
          !options.subprojectId
          || String(lines[index].subprojectId || 'main') === String(options.subprojectId)
        ));
      if (!selected.length) return [];
      state.dragLineIndex = selected[0];
      state.dragLineIndexes = selected;
      state.dragWholeLineGroup = !!options.wholeGroup;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(options.mimeType, JSON.stringify(selected));
      event.dataTransfer.setData('text/plain', String(selected[0]));
      event.currentTarget?.closest('tr')?.classList.add('dragging');
      return selected;
    },

    draggedIndexes(state, event, options = {}) {
      const parseNumber = options.numberValue || numberValue;
      if (state.dragLineIndexes?.length) return [...state.dragLineIndexes];
      try {
        const payload = JSON.parse(event?.dataTransfer?.getData(options.mimeType) || '[]');
        if (Array.isArray(payload) && payload.length) {
          return payload.map(value => parseNumber(value, -1));
        }
      } catch {}
      const rawSource = event?.dataTransfer?.getData('text/plain');
      const sourceIndex = rawSource === '' ? state.dragLineIndex : parseNumber(rawSource, -1);
      return sourceIndex == null ? [] : [sourceIndex];
    },

    dropPosition(event) {
      const rect = event.currentTarget.getBoundingClientRect();
      return event.currentTarget.dataset.dropPosition
        || (event.clientY < rect.top + (rect.height / 2) ? 'before' : 'after');
    },

    subprojectTabsMarkup(options = {}) {
      const rows = Array.isArray(options.rows) ? options.rows : [];
      const activeId = String(options.activeId || rows[0]?.id || '');
      const prefix = String(options.handlerPrefix || '').replace(/[^a-zA-Z0-9_$]/g, '');
      const canManage = !options.readOnly && options.allowManage !== false;
      const canReorder = !options.readOnly && options.allowReorder !== false && rows.length > 1;
      return `<div class="finance-subproject-tabs showbase-subproject-tabs ${escapeAttribute(options.className || '')}" role="tablist" aria-label="${escapeAttribute(options.ariaLabel || 'Sub-projects')}">
        ${rows.map((row, index) => {
          const id = escapeAttribute(row.id || '');
          const name = escapeAttribute(row.name || 'Untitled');
          return `${canReorder ? `
            <span class="finance-subproject-drop-slot ${index === 0 ? 'is-first' : ''}" aria-hidden="true"
                  data-drop-index="${index}"
                  ondragover="${prefix}SubprojectSlotDragOver(event,${index})"
                  ondragleave="${prefix}SubprojectSlotDragLeave(event)"
                  ondrop="${prefix}SubprojectDropAtIndex(event,${index})"></span>
          ` : ''}
          <span class="finance-subproject-tab ${String(row.id || '') === activeId ? 'active' : ''}"
                data-subproject-id="${id}"
                ${canReorder ? `draggable="true"
                  ondragstart="${prefix}SubprojectDragStart(event,'${id}')"
                  ondragend="${prefix}SubprojectDragEnd()"` : ''}
                ondragover="${prefix}SubprojectDragOver(event,'${id}')"
                ondragleave="${prefix}SubprojectDragLeave(event)"
                ondrop="${prefix}SubprojectDrop(event,'${id}')">
            ${canReorder ? `<span class="finance-subproject-drag-handle" role="button" tabindex="0"
                  title="Drag to reorder room" aria-label="Reorder ${name}"
                  onkeydown="${prefix}SubprojectDragKeydown(event,'${id}')">&#9776;</span>` : ''}
            <button type="button" role="tab" aria-selected="${String(row.id || '') === activeId}" onclick="${prefix}SelectSubproject('${id}')">${name}</button>
            ${canManage ? `<button type="button" class="finance-subproject-edit" title="Rename sub-project" onclick="${prefix}RenameSubproject('${id}')">&#9998;</button>` : ''}
            ${canManage && rows.length > 1 ? `<button type="button" class="finance-subproject-delete" title="Delete sub-project" onclick="${prefix}DeleteSubproject('${id}')">&times;</button>` : ''}
          </span>`;
        }).join('')}
        ${canReorder ? `<span class="finance-subproject-end-drop" aria-hidden="true"
              ondragover="${prefix}SubprojectEndDragOver(event)"
              ondragleave="${prefix}SubprojectEndDragLeave(event)"
              ondrop="${prefix}SubprojectDropAtEnd(event)"></span>` : ''}
        ${canManage ? `<button type="button" class="finance-subproject-add" onclick="${prefix}AddSubproject()">+ Sub-project</button>` : ''}
      </div>`;
    },

    reorderSubprojectsAtIndex(rows, sourceId, targetIndex) {
      return reorderAtIndex(rows, sourceId, targetIndex);
    },

    reorderSubprojects(rows, sourceId, targetId, position = 'before') {
      return reorderRelative(rows, sourceId, targetId, position);
    },

    createSubprojectController(options = {}) {
      const state = options.state || {};
      const getRows = options.getRows || (() => []);
      const commit = options.commit || (() => false);
      const isReadOnly = options.isReadOnly || (() => false);
      const mimeType = options.mimeType || 'application/x-showbase-room';

      function clearDropTargets() {
        document.querySelectorAll('.finance-subproject-tab').forEach(tab => {
          tab.classList.remove('is-reorder-before', 'is-reorder-after');
          delete tab.dataset.reorderPosition;
        });
        document.querySelectorAll(
          '.finance-subproject-end-drop.is-active,.finance-subproject-drop-slot.is-active'
        ).forEach(target => target.classList.remove('is-active'));
      }

      function sourceId(event) {
        return state.dragSubprojectId
          || event.dataTransfer?.getData(mimeType)
          || event.dataTransfer?.getData('text/plain');
      }

      function reorder(source, target, position = 'before') {
        return commit(reorderRelative(getRows(), source, target, position));
      }

      return {
        clearDropTargets,
        dragStart(event, subprojectId) {
          if (isReadOnly()) {
            event.preventDefault();
            return;
          }
          state.dragSubprojectId = subprojectId;
          event.currentTarget.closest('.finance-subproject-tab')?.classList.add('is-dragging');
          if (!event.dataTransfer) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(mimeType, subprojectId);
          event.dataTransfer.setData('text/plain', subprojectId);
        },
        dragOver(event, targetId) {
          if (!state.dragSubprojectId || state.dragSubprojectId === targetId) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          clearDropTargets();
          const rect = event.currentTarget.getBoundingClientRect();
          const position = event.clientX < rect.left + (rect.width / 2) ? 'before' : 'after';
          event.currentTarget.classList.add(`is-reorder-${position}`);
          event.currentTarget.dataset.reorderPosition = position;
        },
        dragLeave(event) {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          event.currentTarget.classList.remove('is-reorder-before', 'is-reorder-after');
          delete event.currentTarget.dataset.reorderPosition;
        },
        endDragOver(event) {
          const rows = getRows();
          if (!state.dragSubprojectId || rows.at(-1)?.id === state.dragSubprojectId) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          clearDropTargets();
          event.currentTarget.classList.add('is-active');
        },
        endDragLeave(event) {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            event.currentTarget.classList.remove('is-active');
          }
        },
        slotDragOver(event, targetIndex) {
          const rows = getRows();
          const sourceIndex = rows.findIndex(row => row.id === state.dragSubprojectId);
          if (sourceIndex < 0) return;
          const adjustedIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
          if (adjustedIndex === sourceIndex) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          clearDropTargets();
          event.currentTarget.classList.add('is-active');
        },
        slotDragLeave(event) {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            event.currentTarget.classList.remove('is-active');
          }
        },
        reorderAtIndex(source, targetIndex) {
          return commit(reorderAtIndex(getRows(), source, targetIndex));
        },
        dropAtIndex(event, targetIndex) {
          event.preventDefault();
          const source = sourceId(event);
          clearDropTargets();
          state.dragSubprojectId = '';
          return commit(reorderAtIndex(getRows(), source, targetIndex));
        },
        reorder,
        drop(event, targetId) {
          event.preventDefault();
          const source = sourceId(event);
          const rect = event.currentTarget.getBoundingClientRect();
          const position = event.currentTarget.dataset.reorderPosition
            || (event.clientX < rect.left + (rect.width / 2) ? 'before' : 'after');
          clearDropTargets();
          state.dragSubprojectId = '';
          return reorder(source, targetId, position);
        },
        dropAtEnd(event) {
          event.preventDefault();
          const source = sourceId(event);
          const lastId = getRows().at(-1)?.id || '';
          clearDropTargets();
          state.dragSubprojectId = '';
          return source && lastId && source !== lastId
            ? reorder(source, lastId, 'after')
            : false;
        },
        dragEnd() {
          state.dragSubprojectId = '';
          clearDropTargets();
          document.querySelectorAll('.finance-subproject-tab.is-dragging')
            .forEach(tab => tab.classList.remove('is-dragging'));
        },
        dragKeydown(event, subprojectId) {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          const rows = getRows();
          const sourceIndex = rows.findIndex(row => row.id === subprojectId);
          const targetIndex = sourceIndex + (event.key === 'ArrowLeft' ? -1 : 1);
          if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= rows.length) return;
          if (!reorder(
            subprojectId,
            rows[targetIndex].id,
            event.key === 'ArrowLeft' ? 'before' : 'after'
          )) return;
          const escapedId = global.CSS?.escape
            ? global.CSS.escape(subprojectId)
            : escapeAttribute(subprojectId);
          requestAnimationFrame(() => document.querySelector(
            `.finance-subproject-tab[data-subproject-id="${escapedId}"] .finance-subproject-drag-handle`
          )?.focus());
        }
      };
    }
  };
})(window);
