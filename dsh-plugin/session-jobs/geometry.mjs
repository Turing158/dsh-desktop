/**
 * Placement of the session-jobs control and its popup, as pure arithmetic.
 *
 * Both surfaces are absolutely/fixed positioned from measured rects rather than
 * from a CSS offset chain, because the header they hang off is a grid the app
 * owns and its padding, tab strip, and corner seat are all free to change. The
 * arithmetic lives here so it can be tested against the geometry in the user's
 * own report without a browser.
 *
 * @module @dsh-desktop/session-jobs/geometry
 */

/** The control's square edge, matching the header's other utility buttons. */
export const CONTROL_SIZE = 28
/** Gap between the trigger and its panel. */
export const PANEL_GAP = 6
/** Closest either surface may come to a viewport edge. */
export const EDGE = 8
/** Preferred panel width; a narrow viewport shrinks it instead. */
export const PANEL_WIDTH = 360
/** Below this the panel would be narrower than its own rows need. */
export const PANEL_MIN_WIDTH = 240

const painted = box => Boolean(box) && box.width > 0 && box.height > 0

/**
 * Where the seat sits, in `<header>`-relative pixels.
 *
 * Right edge: the corner control's, so this button lines up with the shipped
 * 打开侧边栏 control; the tabs strip's edge and the header's own padding are
 * fallbacks for a composition that has neither.
 * Vertical: centred on the tabs row, and clamped inside the header so the
 * control can never hang past its bottom edge.
 * @param header - the header element's rect.
 * @param corner - the corner control's rect, when it painted one.
 * @param tabs - the view-tabs strip's rect, when the session has tabs.
 * @returns `right` and `top` offsets for the absolutely positioned seat.
 */
export function seatGeometry(header, corner, tabs) {
  const edge = painted(corner) ? corner.right : painted(tabs) ? tabs.right : header.right - EDGE
  const right = Math.max(0, Math.round(header.right - edge))
  const top = painted(tabs)
    ? Math.round(tabs.top - header.top + (tabs.height - CONTROL_SIZE) / 2)
    : Math.round(header.height - CONTROL_SIZE - EDGE)
  return { right, top: Math.max(0, Math.min(top, Math.round(header.height - CONTROL_SIZE))) }
}

/**
 * The panel's fixed-position box: right-aligned under the trigger, and flipped
 * above it when the viewport has no room below. `size` may be unmeasured (zero
 * height) on the first frame, in which case the panel opens downward and is
 * re-placed once its content has a height.
 * @param anchor - the trigger's rect.
 * @param size - the measured panel size.
 * @param viewport - the visual viewport size.
 * @returns `left`, `top`, and `width` in viewport pixels.
 */
export function panelGeometry(anchor, size, viewport) {
  const width = Math.min(PANEL_WIDTH, Math.max(PANEL_MIN_WIDTH, viewport.width - EDGE * 2))
  const left = Math.max(EDGE, Math.min(anchor.right - width, viewport.width - width - EDGE))
  const below = anchor.bottom + PANEL_GAP
  const top = size.height > 0 && below + size.height > viewport.height - EDGE
    ? Math.max(EDGE, anchor.top - size.height - PANEL_GAP)
    : below
  return { left: Math.round(left), top: Math.round(top), width }
}
