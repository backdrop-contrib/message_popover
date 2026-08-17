# Changelog

All notable changes to Message Popover are recorded here.

## 1.x-1.2.0 (unreleased)

### Changed — markup contract

- **The `messages` class has been removed from message markup.** Messages now
  carry only their severity class and `message-popover-item`. Core's
  `messages.theme.css` and theme stylesheets target `div.messages.status:before`
  at a higher specificity than this module could use, painting a second icon
  onto the severity strip and overriding its colour. Anything selecting
  `.messages` to style or script this module's output will need updating.

### Added

- Layout toggle button on every message, switching the set between the stacked
  list and a compact cascade, for batches too tall to fit on screen.
- Hold button pausing auto-dismiss for all messages, plus automatic pausing
  while a message is hovered or focused.
- Screen position setting: Left, Centre or Right, with a pixel offset. For
  Centre the offset is a signed shift, so messages can sit off-centre. Messages
  are always clamped to stay fully on screen regardless of the offset, the
  message width, or the window being resized.
- Movement is now animated when the stack re-flows, respecting
  `prefers-reduced-motion`.

### Fixed

- **Warning and error icons did not render.** Both referenced Font Awesome
  names (`exclamation-triangle.svg`, `exclamation-circle.svg`) that do not
  exist in Backdrop core, which ships Phosphor icons. Now `warning.svg` and
  `warning-circle.svg`. The error icon had been blank since the icons were
  introduced.
- **A second, larger icon appeared over the severity strip**, from core's own
  message styling. Resolved by dropping the `messages` class (above).
- **Severity strip colours were being overridden by the theme.** Warning and
  error strips rendered in the theme's colours rather than the module's.
- **Messages could stack off the bottom of the screen and be unreachable.**
  Popovers render in the browser top layer and cannot be scrolled to. Messages
  are now capped to the viewport height and scroll internally, and the cascade
  layout is available for long runs of messages. Note that errors and long
  messages never auto-dismiss, so a form failing validation on several fields
  was a common way to hit this.
- **Gaps were left in the stack when a message was dismissed.** Remaining
  messages now close up.
- Dragged messages are no longer pulled back into the stack when an unrelated
  message is dismissed.

### Accessibility

- Header strip raised from 14px to 24px so all header buttons meet the WCAG 2.2
  AA minimum target size of 24×24 (2.5.8). The close button previously did not.
- Visible keyboard focus styling on all header buttons; the close button
  previously had none.
- Auto-dismiss pauses on keyboard focus as well as hover, so a message
  containing a link cannot fade while it is being tabbed through.
- The hold button reports state via `aria-pressed`.
- Links within messages remain underlined, preserved from the core styling
  dropped with the `messages` class.

## 1.x-1.1.0

- Draggable popovers using the native Popover API, with AJAX fixes.

## 1.x-1.0.0

- Initial stable release.

## 1.x-1.0.0-beta3

- PHP 7.1 compatibility layer and UI refinements.

## 1.x-1.0.0-beta2

- Icon path fixes in CSS.
