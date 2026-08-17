(function() {
  'use strict';

  var popoverSupported = typeof HTMLElement.prototype.showPopover === 'function';

  // Single module-scoped drag state consumed by the delegated document
  // listeners below. Per-popover document listeners would accumulate (never
  // removed) and their closures would pin removed elements against GC.
  var dragEl = null;
  var dragOffsetX = 0;
  var dragOffsetY = 0;

  // Header strip height in px — the drag target, and the step the cascade
  // reveals. Read from the --message-popover-header custom property so the
  // stylesheet stays the single source of truth; the literal is only a guard
  // for the case where the CSS has not loaded yet.
  function headerHeight(el) {
    const value = parseFloat(
      getComputedStyle(el).getPropertyValue('--message-popover-header')
    );
    return isNaN(value) ? 24 : value;
  }

  // Current layout for the whole set: 'tidy' (vertical list, default) or
  // 'cascade' (fixed small step, so many messages still fit on screen).
  // Messages arriving later join whichever mode is active.
  var layoutMode = 'tidy';

  // Auto-dismiss bookkeeping, element -> {id, deadline, remaining}. A WeakMap
  // so a dismissed message's record goes with it, as with the drag state.
  var timers = new WeakMap();

  // True while the user has held the set open from the header button.
  var held = false;

  // The configured timer, kept module-scoped so a released message can be
  // given a fresh full countdown rather than its banked remainder.
  var fullDismissTime = 8000;

  // Relayout is coalesced into one frame: Escape closes every message at once,
  // and messages attached in the same pass share one auto-dismiss timer, so
  // removals arrive in bursts.
  var relayoutQueued = false;

  Backdrop.behaviors.messagePopover = {
    attach: function(context, settings) {
      // Core's ajax.js passes a jQuery object as context (e.g. Views UI dialog
      // inserts). attachBehaviors has no try/catch, so calling a native DOM
      // method on it throws and aborts the whole AJAX command chain — the
      // dialog never opens. Normalize to a DOM node before any native call.
      if (context && context.jquery) {
        context = (context.length === 1) ? context[0] : document;
      }
      if (!context || typeof context.querySelectorAll !== 'function') {
        context = document;
      }
      const messages = context.querySelectorAll('[popover].message-popover-item:not(.popover-processed)');
      // 0 is a valid configured value (auto-dismiss disabled) — only fall back
      // to the default when the setting is genuinely absent.
      const dismissTime = (settings.messagePopover && typeof settings.messagePopover.timer !== 'undefined')
        ? settings.messagePopover.timer : 8000;
      fullDismissTime = dismissTime;

      messages.forEach((el) => {
        el.classList.add('popover-processed');

        // Hold the countdown while the message is being read or tabbed
        // through. Element listeners die with the element, so no cleanup.
        el.addEventListener('mouseenter', () => pauseTimer(el));
        el.addEventListener('mouseleave', () => startTimer(el));
        el.addEventListener('focusin', () => pauseTimer(el));
        el.addEventListener('focusout', () => startTimer(el));

        // No Popover API: show as a fixed toast via CSS class instead of
        // silently losing the message. Stacked manually; the delegated click
        // handler below covers the close button (popovertarget is inert here).
        if (!popoverSupported) {
          el.classList.add('popover-fallback');
          queueRelayout();
          scheduleAutoDismiss(el, dismissTime);
          return;
        }

        el.addEventListener('toggle', (event) => {
          if (event.newState === 'closed') {
            // A closing popover has already dropped out of :popover-open, so
            // relayout can close the gap now rather than waiting on the
            // removal timer below.
            queueRelayout();
            setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
          }
        });

        el.addEventListener('mousedown', startDrag);

        try {
          el.showPopover();
        } catch (e) {
          el.classList.add('popover-fallback');
        }
        queueRelayout();
        scheduleAutoDismiss(el, dismissTime);
      });
    }
  };

  // Every message currently on screen, in document order — which is the order
  // they were set, so relayout never reshuffles them.
  function visibleMessages() {
    // :is() is forgiving, so the unknown :popover-open branch is dropped rather
    // than invalidating the whole selector. Only used where the API exists.
    const selector = popoverSupported
      ? ':is(.message-popover-item:popover-open, .message-popover-item.popover-fallback)'
      : '.message-popover-item.popover-fallback';
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  // Request a relayout on the next frame, collapsing a burst into one pass.
  function queueRelayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      relayout();
    });
  }

  // Smallest gap left between a message and the viewport edge when clamping.
  var EDGE_MARGIN = 8;

  // Resolve a message's horizontal placement to a clamped pixel distance from
  // one inline edge, honouring the configured position and offset.
  //
  // Returns which edge to measure from as well as the distance, so the caller
  // can anchor right-positioned messages to inset-inline-end — that way the
  // whole thing still mirrors correctly under RTL.
  //
  // Clamping is the point of doing this in JS at all: the box is
  // width:fit-content, so an offset that is harmless for a short "Saved."
  // pushes a long message off screen, and CSS cannot see the difference.
  function clampedInlineStart(el, step) {
    const styles = getComputedStyle(el);
    const edge = parseFloat(styles.getPropertyValue('--message-popover-edge')) || 0;
    const viewport = document.documentElement.clientWidth;
    const width = el.offsetWidth;

    // Nothing sensible to clamp to if the message is wider than the viewport;
    // pin it to the start edge and let max-width deal with it.
    const limit = viewport - width - EDGE_MARGIN;
    if (limit < EDGE_MARGIN) {
      return { property: 'insetInlineStart', value: EDGE_MARGIN };
    }

    if (el.classList.contains('popover-pos-left')) {
      return {
        property: 'insetInlineStart',
        value: Math.max(EDGE_MARGIN, Math.min(edge + step, limit)),
      };
    }
    if (el.classList.contains('popover-pos-right')) {
      return {
        property: 'insetInlineEnd',
        value: Math.max(EDGE_MARGIN, Math.min(edge + step, limit)),
      };
    }
    // Centre: the offset shifts away from centre in either direction.
    const centred = (viewport - width) / 2;
    return {
      property: 'insetInlineStart',
      value: Math.max(EDGE_MARGIN, Math.min(centred + edge + step, limit)),
    };
  }

  // Position every visible message according to the current layout mode.
  //
  // Messages the user has dragged somewhere are left alone and excluded from
  // the running offset — having a deliberately moved window snap back because
  // an unrelated message auto-dismissed would be worse than the gap.
  function relayout() {
    let offset = 65;
    let inlineStep = 0;

    visibleMessages().forEach((el) => {
      if (el.getAttribute('data-user-moved') === 'true') return;

      // Clear what a previous drag left behind before measuring.
      el.style.width = '';

      el.style.insetBlockStart = offset + 'px';

      // Horizontal placement is resolved to measured pixels rather than left
      // to CSS, so it can be clamped inside the viewport. That means taking
      // over from the stylesheet's translateX(-50%) centring too.
      const anchor = clampedInlineStart(el, inlineStep);
      el.style.transform = 'none';
      el.style.insetInlineStart = 'auto';
      el.style.insetInlineEnd = 'auto';
      el.style[anchor.property] = anchor.value + 'px';

      if (layoutMode === 'cascade') {
        // Fixed step, no measuring: reveals each window's header strip plus
        // the first line of its text.
        offset += headerHeight(el) + 16;
        inlineStep += 24;
      }
      else {
        offset += el.offsetHeight + 12;
      }

      // Enable the movement transition only from the frame AFTER first
      // placement, or the message animates in from its initial paint position.
      if (!el.classList.contains('popover-placed')) {
        requestAnimationFrame(() => el.classList.add('popover-placed'));
      }
    });

    // Messages arriving while cascade or hold is active ship the default
    // markup, so bring their buttons into line with the current state.
    updateLayoutButtons();
    updateHoldButtons();
  }

  // Switch layout mode from the header button. Unlike an automatic relayout
  // this gathers up dragged messages too — the button is the way to get a
  // scattered set back under control.
  function setLayout(mode) {
    layoutMode = mode;
    document.querySelectorAll('.message-popover-item[data-user-moved]').forEach((el) => {
      el.removeAttribute('data-user-moved');
    });
    relayout();
  }

  // Keep the toggle's label describing what it will DO, not the current state.
  function updateLayoutButtons() {
    const label = (layoutMode === 'cascade')
      ? Backdrop.t('Stack messages')
      : Backdrop.t('Cascade messages');
    document.querySelectorAll('.popover-layout').forEach((btn) => {
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    });
  }

  // Register a message for auto-dismissal and start its countdown. A timer of
  // 0 (or less) disables dismissal, as does data-auto-dismiss="false" — PHP
  // sets that for errors, long messages and debug output.
  //
  // The remaining time is tracked rather than fired and forgotten, so the
  // countdown can be paused on hover and by the hold button.
  function scheduleAutoDismiss(el, dismissTime) {
    if (el.getAttribute('data-auto-dismiss') !== 'true' || dismissTime <= 0) {
      return;
    }
    timers.set(el, { id: null, deadline: 0, remaining: dismissTime });
    startTimer(el);
  }

  // (Re)start a paused countdown from whatever time it has left. No-op for
  // messages that never auto-dismiss, and while the set is held open.
  function startTimer(el) {
    const rec = timers.get(el);
    if (!rec || held || rec.id !== null || rec.remaining <= 0) return;
    // Don't resume under the pointer — unlocking while hovering a message
    // would start it fading in the reader's face.
    if (el.matches(':hover')) return;

    rec.deadline = Date.now() + rec.remaining;
    rec.id = setTimeout(() => {
      rec.id = null;
      if (document.body.contains(el)) dismiss(el);
    }, rec.remaining);
  }

  // Stop the countdown, banking the time left for the next startTimer().
  function pauseTimer(el) {
    const rec = timers.get(el);
    if (!rec || rec.id === null) return;

    clearTimeout(rec.id);
    rec.id = null;
    rec.remaining = Math.max(0, rec.deadline - Date.now());
  }

  // Hold every message open, or release them all. Held state applies to
  // messages arriving later too, since startTimer() checks the flag.
  function setHeld(state) {
    held = state;
    visibleMessages().forEach((el) => {
      if (held) {
        pauseTimer(el);
      }
      else {
        // Give a released message the full timer rather than the seconds it
        // happened to have left when it was held — the user has just said
        // they are done reading, so restart the clock.
        const rec = timers.get(el);
        if (rec) rec.remaining = fullDismissTime;
        startTimer(el);
      }
    });
    updateHoldButtons();
  }

  // Reflect held state on every hold button. The label stays constant and the
  // state rides on aria-pressed, which is what screen readers expect of a
  // toggle; the glyph carries it visually.
  function updateHoldButtons() {
    document.querySelectorAll('.popover-hold').forEach((btn) => {
      btn.setAttribute('aria-pressed', held ? 'true' : 'false');
      btn.textContent = held ? '▶' : '⏸';
    });
  }

  // Close a message regardless of display mode (popover or fallback toast).
  function dismiss(el) {
    if (el.classList.contains('popover-fallback')) {
      el.remove();
      queueRelayout();
    }
    else if (el.matches(':popover-open')) {
      // The toggle listener relayouts; nothing to do here.
      el.hidePopover();
    }
  }

  // Drag start — bound per element (element listeners die with the element,
  // so no cleanup is needed). Only the header strip is draggable.
  function startDrag(e) {
    const el = e.currentTarget;
    // Any header button, not just close — the layout toggle lives there too.
    if (e.target.closest('button')) return;

    const rect = el.getBoundingClientRect();
    if (e.clientY - rect.top > headerHeight(el)) return;

    dragEl = el;
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    el.style.cursor = 'grabbing';
    el.style.width = el.offsetWidth + 'px';
    el.style.transform = 'none';
    el.classList.add('popover-dragging');
    e.preventDefault();
  }

  // Delegated drag listeners — registered exactly once for the document.
  document.addEventListener('mousemove', (e) => {
    if (!dragEl) return;
    dragEl.style.insetInlineStart = (e.clientX - dragOffsetX) + 'px';
    dragEl.style.insetBlockStart = (e.clientY - dragOffsetY) + 'px';
    dragEl.style.insetInlineEnd = 'auto';
    // Marked here rather than on mousedown so a plain click on the header
    // strip does not exempt the message from relayout.
    dragEl.setAttribute('data-user-moved', 'true');
  });

  document.addEventListener('mouseup', () => {
    if (dragEl) {
      dragEl.style.cursor = '';
      dragEl.classList.remove('popover-dragging');
      // Close the gap the dragged message left in the stack.
      if (dragEl.getAttribute('data-user-moved') === 'true') queueRelayout();
      dragEl = null;
    }
  });

  // Horizontal placement is now measured in pixels rather than left to CSS
  // percentages, so it no longer follows the viewport on its own. Relayout on
  // resize keeps the clamp honest — otherwise narrowing the window strands
  // messages off the edge, which is the bug the clamp exists to prevent.
  window.addEventListener('resize', queueRelayout);

  // popover="manual" does not light-dismiss, so offer Escape to close all
  // visible messages explicitly.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.message-popover-item.popover-processed').forEach((el) => {
      dismiss(el);
    });
  });

  // Header button clicks, delegated so messages added later are covered.
  document.addEventListener('click', (e) => {
    const layoutBtn = e.target.closest('.popover-layout');
    if (layoutBtn) {
      setLayout(layoutMode === 'cascade' ? 'tidy' : 'cascade');
      return;
    }

    const holdBtn = e.target.closest('.popover-hold');
    if (holdBtn) {
      setHeld(!held);
      return;
    }

    // Fallback mode: popovertarget close buttons are inert without the Popover
    // API, so handle the click directly.
    const btn = e.target.closest('.popover-close');
    if (!btn) return;
    const el = btn.closest('.message-popover-item');
    if (el && el.classList.contains('popover-fallback')) {
      el.remove();
      queueRelayout();
    }
  });
})();
