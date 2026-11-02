// Presentation-only primitives shared by the native workbench and graph editor.
let activeMenu = null;
const tooltipDismissers = new Set();
let nextId = 0;
const EDGE = 8;
const TOOLTIP_GAP = 6;
const TOOLTIP_LEAVE_DELAY = 120;

function uniqueId(document, prefix) {
  let id;
  do { id = `${prefix}-${++nextId}`; } while (document.getElementById(id));
  return id;
}

function viewport(document) {
  const view = document.defaultView;
  const visual = view.visualViewport;
  return {
    left: (visual?.offsetLeft || 0) + EDGE,
    top: (visual?.offsetTop || 0) + EDGE,
    width: Math.max(1, (visual?.width || document.documentElement.clientWidth || view.innerWidth) - EDGE * 2),
    height: Math.max(1, (visual?.height || document.documentElement.clientHeight || view.innerHeight) - EDGE * 2),
  };
}

function prepareOverlay(element, bounds) {
  Object.assign(element.style, {
    position: 'fixed', boxSizing: 'border-box', minWidth: '0',
    maxWidth: `${bounds.width}px`, maxHeight: `${bounds.height}px`,
    overflowY: 'auto', overflowX: 'hidden', overflowWrap: 'anywhere',
  });
}

function placeOverlay(element, x, y, bounds) {
  const rect = element.getBoundingClientRect();
  element.style.left = `${Math.max(bounds.left, Math.min(x, bounds.left + bounds.width - rect.width))}px`;
  element.style.top = `${Math.max(bounds.top, Math.min(y, bounds.top + bounds.height - rect.height))}px`;
}

function overlayHost(document, anchor) {
  // A body portal would be inert while its opener's native modal is open.
  return anchor?.closest?.('dialog[open]') || document.body || document.documentElement;
}

function addDescription(element, id) {
  const ids = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (!ids.includes(id)) element.setAttribute('aria-describedby', [...ids, id].join(' '));
}

function removeDescription(element, id) {
  const ids = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id);
  if (ids.length) element.setAttribute('aria-describedby', ids.join(' '));
  else element.removeAttribute('aria-describedby');
}

/**
 * Open from a contextmenu handler or a visible button's click handler. Opening
 * never runs an action; only activating an enabled item calls onAction(id, context).
 */
export function createContextMenu({onAction} = {}) {
  let state = null;
  let destroyed = false;
  let actionHandler = onAction;

  function dismiss(restoreFocus) {
    if (!state) return;
    const current = state;
    state = null;
    if (activeMenu?.dismiss === dismiss) activeMenu = null;
    const focused = current.document.activeElement;
    const restore = restoreFocus && (current.menu.contains(focused) || focused === current.document.body);
    current.bindings.abort();
    current.observer.disconnect();
    current.menu.remove();
    if (restore && current.opener?.isConnected && !current.opener.matches(':disabled,[inert]') && !current.opener.closest('[inert]')) {
      current.opener.focus({preventScroll: true});
    }
  }

  function open({anchor, x, y, title, items = [], context} = {}) {
    if (destroyed || (anchor && !anchor.isConnected)) return;
    const document = anchor?.ownerDocument || globalThis.document;
    const previous = activeMenu?.opener?.ownerDocument === document ? activeMenu.opener : document.activeElement;
    activeMenu?.dismiss(false);
    dismiss(false);
    const view = document.defaultView;
    const menu = document.createElement('div');
    menu.className = 'ff-context-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.style.zIndex = '10000';
    const heading = document.createElement('div');
    heading.className = 'ff-context-menu__title';
    heading.id = uniqueId(document, 'ff-context-menu-title');
    heading.textContent = String(title || 'Actions');
    menu.setAttribute('aria-labelledby', heading.id);
    menu.append(heading);
    const actions = new Map();
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ff-context-menu__item${item.destructive ? ' is-destructive' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      button.disabled = Boolean(item.disabled);
      const label = document.createElement('span');
      label.className = 'ff-context-menu__label';
      label.id = uniqueId(document, 'ff-context-menu-label');
      label.textContent = String(item.label ?? '');
      label.style.display = 'block';
      button.setAttribute('aria-labelledby', label.id);
      button.append(label);
      if (item.description) {
        const description = document.createElement('span');
        description.className = 'ff-context-menu__description';
        description.id = uniqueId(document, 'ff-context-menu-description');
        description.textContent = String(item.description);
        description.style.display = 'block';
        button.setAttribute('aria-describedby', description.id);
        button.append(description);
      }
      actions.set(button, item.id);
      menu.append(button);
    }
    const opener = anchor?.closest?.('button,a[href],input,select,textarea,[tabindex]') || previous;
    const bindings = new view.AbortController();
    const options = {signal: bindings.signal};
    const observer = new view.MutationObserver(() => {
      if (!menu.isConnected || (anchor && !anchor.isConnected)) dismiss(false);
    });
    state = {menu, opener, document, bindings, observer};
    activeMenu = {dismiss, opener};
    for (const hideTooltip of tooltipDismissers) hideTooltip();
    const position = () => {
      const bounds = viewport(document);
      prepareOverlay(menu, bounds);
      const rect = anchor?.getBoundingClientRect();
      placeOverlay(menu, Number.isFinite(x) ? x : rect?.left ?? bounds.left,
        Number.isFinite(y) ? y : rect?.bottom ?? bounds.top, bounds);
    };
    overlayHost(document, anchor).append(menu);
    position();
    observer.observe(document.documentElement, {childList: true, subtree: true});
    const enabled = [...actions.keys()].filter(button => !button.disabled);
    (enabled[0] || menu).focus({preventScroll: true});

    menu.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (!actions.has(button) || button.disabled) return;
      event.stopPropagation();
      const id = actions.get(button);
      // Restore synchronously BEFORE the action. A dialog/panel focused by the
      // action wins; no deferred restoration can steal its focus afterward.
      dismiss(true);
      actionHandler?.(id, context);
    }, options);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
        return;
      }
      if (event.key === 'Tab') {
        // Let native tab navigation continue from the opener, not a body portal.
        dismiss(true);
        return;
      }
      if (!menu.contains(event.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = enabled.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % enabled.length
          : (index <= 0 ? enabled.length : index) - 1;
      enabled[next]?.focus({preventScroll: true});
      enabled[next]?.scrollIntoView({block: 'nearest'});
    }, {...options, capture: true});
    const outside = event => {
      if (!menu.contains(event.target)) dismiss(true);
    };
    document.addEventListener('pointerdown', outside, {...options, capture: true});
    document.addEventListener('click', outside, {...options, capture: true});
    document.addEventListener('focusin', outside, options);
    view.addEventListener('resize', position, options);
    view.addEventListener('scroll', event => {
      // A scroll queued before open can arrive afterward. Reposition instead of
      // dismissing a newly opened menu; real scrolling follows the anchor too.
      if (!event.target?.nodeType || !menu.contains(event.target)) position();
    }, {...options, capture: true});
    view.addEventListener('blur', () => dismiss(false), options);
    view.visualViewport?.addEventListener('resize', position, options);
    view.visualViewport?.addEventListener('scroll', position, options);
  }

  return {
    open,
    close() { dismiss(true); },
    destroy() { dismiss(true); destroyed = true; actionHandler = null; },
  };
}

/**
 * Delegated supplemental text for [data-tooltip]. Native titles are untouched.
 * For a disabled control's keyboard explanation, put data-tooltip on a focusable
 * wrapper (for example span[tabindex="0"]), not solely on the disabled control.
 */
export function installInfoTooltips(root = document) {
  const document = root.ownerDocument || root;
  const view = document.defaultView;
  const bindings = new view.AbortController();
  const options = {signal: bindings.signal};
  let destroyed = false;
  let windowBlurred = false;
  let trigger = null;
  let tooltip = null;
  let tooltipBindings = null;
  let pointerTarget = null;
  let focusTarget = null;
  let tooltipHovered = false;
  let tooltipBounds = null;
  let pointerX = null;
  let pointerY = null;
  let dismissedTarget = null;
  let hideTimer = null;

  const inRoot = element => element && (element === root || root.contains(element));
  const valid = element => inRoot(element) && element.isConnected
    && Boolean(element.getAttribute('data-tooltip')?.trim())
    && !element.closest('[hidden],[inert]') && element.getClientRects().length > 0;
  function targetFor(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const target = element?.closest('[data-tooltip]');
    return valid(target) ? target : null;
  }
  function clearHideTimer() {
    if (hideTimer !== null) view.clearTimeout(hideTimer);
    hideTimer = null;
  }
  function hide() {
    clearHideTimer();
    tooltipBindings?.abort();
    tooltipBindings = null;
    if (trigger && tooltip) removeDescription(trigger, tooltip.id);
    tooltip?.remove();
    tooltip = null;
    trigger = null;
    tooltipBounds = null;
    tooltipHovered = false;
  }
  function updateTooltipPointerEvents() {
    if (!tooltip || !tooltipBounds || pointerX === null || pointerY === null) return;
    const inside = pointerX >= tooltipBounds.left && pointerX <= tooltipBounds.right
      && pointerY >= tooltipBounds.top && pointerY <= tooltipBounds.bottom;
    if (!inside) { tooltip.style.pointerEvents = ''; return; }
    const underneath = document.elementsFromPoint(pointerX, pointerY)
      .find(element => element !== tooltip && !tooltip.contains(element));
    const control = underneath?.closest('button,a,summary,input,select,textarea,[tabindex]:not([tabindex="-1"])');
    tooltip.style.pointerEvents = control ? 'none' : '';
  }
  function position() {
    if (!trigger || !tooltip) return;
    if (!valid(trigger)) { hide(); return; }
    const bounds = viewport(document);
    const anchor = trigger.getBoundingClientRect();
    const gap = TOOLTIP_GAP;
    const width = Math.min(360, bounds.width);
    const maxHeight = Math.min(280, bounds.height);
    const belowSpace = Math.max(1, bounds.top + bounds.height - anchor.bottom - gap);
    const aboveSpace = Math.max(1, anchor.top - bounds.top - gap);
    const variants = [];
    for (const side of ['below', 'above']) {
      const availableHeight = Math.min(maxHeight, side === 'below' ? belowSpace : aboveSpace);
      prepareOverlay(tooltip, {...bounds, width, height: availableHeight});
      const rect = tooltip.getBoundingClientRect();
      variants.push({side, width: rect.width, height: rect.height, maxHeight: availableHeight});
    }
    const controls = [...document.querySelectorAll('button,a,summary,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter(element => !tooltip.contains(element)
        && !element.closest('[hidden],[inert]') && element.getClientRects().length > 0)
      .map(element => ({
        element,
        rect: element.getBoundingClientRect(),
        channel: element.matches('.platform-group button,.platform-group summary'),
      }));
    let best = null;
    for (const variant of variants) {
      const xs = [...new Set([
        anchor.left + (anchor.width - variant.width) / 2,
        anchor.right + gap,
        anchor.left - variant.width - gap,
        bounds.left,
        bounds.left + (bounds.width - variant.width) / 2,
        bounds.left + bounds.width - variant.width,
      ])].map(x => Math.max(bounds.left, Math.min(x, bounds.left + bounds.width - variant.width)));
      const minY = variant.side === 'below' ? anchor.bottom + gap : bounds.top;
      const maxY = variant.side === 'below'
        ? bounds.top + bounds.height - variant.height
        : anchor.top - gap - variant.height;
      if (maxY < minY) continue;
      const ys = [...new Set([minY, maxY, minY + (maxY - minY) / 2])];
      for (const left of xs) for (const top of ys) {
        const placed = {left, top, right: left + variant.width, bottom: top + variant.height};
        let collisions = 0;
        for (const control of controls) {
          const area = Math.max(0, Math.min(placed.right, control.rect.right) - Math.max(placed.left, control.rect.left))
            * Math.max(0, Math.min(placed.bottom, control.rect.bottom) - Math.max(placed.top, control.rect.top));
          collisions += area * (control.channel ? 100 : 1);
        }
        const distance = Math.abs((placed.left + placed.right - anchor.left - anchor.right) / 2)
          + Math.abs((placed.top + placed.bottom - anchor.top - anchor.bottom) / 2);
        const score = collisions * 10000 + distance;
        if (!best || score < best.score) best = {...variant, left, top, score};
      }
    }
    if (!best) {
      const variant = variants[0];
      best = {...variant, left: bounds.left, top: bounds.top};
    }
    prepareOverlay(tooltip, {...bounds, width, height: best.maxHeight});
    tooltip.style.left = `${best.left}px`;
    tooltip.style.top = `${best.top}px`;
    const rect = tooltip.getBoundingClientRect();
    tooltipBounds = {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
    updateTooltipPointerEvents();
  }
  function show(target) {
    if (destroyed || activeMenu || windowBlurred || !valid(target) || target === dismissedTarget) return;
    clearHideTimer();
    if (trigger !== target || !tooltip?.isConnected) {
      hide();
      trigger = target;
      tooltip = document.createElement('div');
      tooltip.id = uniqueId(document, 'ff-info-tooltip');
      tooltip.className = 'ff-info-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.style.zIndex = '10001';
      tooltipBindings = new view.AbortController();
      const tooltipOptions = {signal: tooltipBindings.signal};
      tooltip.addEventListener('pointerenter', () => {
        tooltipHovered = true;
        clearHideTimer();
      }, tooltipOptions);
      tooltip.addEventListener('pointerleave', () => {
        tooltipHovered = false;
        reconcile();
      }, tooltipOptions);
      overlayHost(document, target).append(tooltip);
      addDescription(target, tooltip.id);
    }
    const text = target.getAttribute('data-tooltip').trim();
    if (tooltip.textContent !== text) tooltip.textContent = text;
    position();
  }
  function reconcile() {
    if (destroyed) return;
    if (root.nodeType !== 9 && !root.isConnected) { destroy(); return; }
    if (windowBlurred) return;
    if (!valid(pointerTarget)) pointerTarget = null;
    if (!valid(focusTarget)) focusTarget = null;
    if (dismissedTarget !== pointerTarget && dismissedTarget !== focusTarget) dismissedTarget = null;
    if (trigger && (!valid(trigger) || !tooltip?.isConnected)) hide();
    if (trigger && (pointerTarget === trigger || focusTarget === trigger || tooltipHovered)) {
      show(trigger);
      return;
    }
    const target = pointerTarget || focusTarget;
    if (target && target !== dismissedTarget) { show(target); return; }
    if (tooltip && hideTimer === null) hideTimer = view.setTimeout(hide, TOOLTIP_LEAVE_DELAY);
  }
  function refresh() {
    if (destroyed) return;
    focusTarget = windowBlurred ? null : targetFor(document.activeElement);
    reconcile();
  }
  const observer = new view.MutationObserver(records => {
    // Positioning our own bubble changes style; do not observe ourselves into
    // an update loop while still reacting to a trigger's class/style hiding.
    if (records.some(record => record.target.isConnected && record.target !== tooltip && !tooltip?.contains(record.target))) refresh();
  });
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    tooltipDismissers.delete(hide);
    bindings.abort();
    observer.disconnect();
    hide();
    pointerTarget = null;
    focusTarget = null;
    dismissedTarget = null;
  }

  tooltipDismissers.add(hide);
  root.addEventListener('pointerover', event => {
    pointerTarget = targetFor(event.target);
    if (pointerTarget) show(pointerTarget);
    else reconcile();
  }, {...options, capture: true});
  root.addEventListener('pointerout', event => {
    pointerTarget = targetFor(event.relatedTarget);
    reconcile();
  }, {...options, capture: true});
  document.addEventListener('pointermove', event => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    updateTooltipPointerEvents();
  }, {...options, capture: true});
  root.addEventListener('focusin', event => {
    focusTarget = targetFor(event.target);
    if (focusTarget) show(focusTarget);
    else reconcile();
  }, options);
  root.addEventListener('focusout', event => {
    focusTarget = targetFor(event.relatedTarget);
    reconcile();
  }, options);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !tooltip) return;
    dismissedTarget = trigger;
    hide();
  }, {...options, capture: true});
  view.addEventListener('resize', position, options);
  view.addEventListener('scroll', position, {...options, capture: true});
  view.addEventListener('blur', () => {
    windowBlurred = true;
    pointerTarget = null;
    focusTarget = null;
    dismissedTarget = null;
    hide();
  }, options);
  view.addEventListener('focus', () => { windowBlurred = false; refresh(); }, options);
  view.visualViewport?.addEventListener('resize', position, options);
  view.visualViewport?.addEventListener('scroll', position, options);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-tooltip', 'hidden', 'inert', 'disabled', 'style', 'class'],
  });
  refresh();
  return {refresh, destroy};
}
