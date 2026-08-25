import { useId, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";

type Placement = "below" | "below-end";

type TriggerProps = {
  "aria-describedby": string | undefined;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/**
 * A visible description for a control whose meaning is otherwise carried only by
 * an icon or an `aria-label`.
 *
 * Four constraints shape it:
 *
 * - It appears on keyboard focus as well as on hover, so it is not mouse-only.
 * - Escape dismisses it without closing whatever is behind it (WCAG 2.1 1.4.13);
 *   inside a dialog that means the first Escape hides the tooltip and the second
 *   closes the dialog.
 * - It describes, never names. `aria-describedby` cannot overwrite the control's
 *   own accessible name, which `aria-label` on a wrapper would.
 * - It renders *inside* the trigger, not beside it, because several triggers are
 *   grid items sitting in a column sized for exactly one box. A sibling wrapper
 *   would take the trigger's place in that grid and the layout would shift.
 *
 * The caller adds `has-tooltip` to the trigger's class list: the bubble is
 * absolutely positioned and needs the trigger as its containing block.
 */
export function useTooltip(
  text: string,
  placement: Placement = "below",
): { triggerProps: TriggerProps; tip: ReactNode } {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const visible = open && !dismissed;

  function show() {
    setDismissed(false);
    setOpen(true);
  }

  return {
    triggerProps: {
      "aria-describedby": visible ? id : undefined,
      onMouseEnter: show,
      onMouseLeave: () => setOpen(false),
      // A pointer already got the tooltip from hover. Showing it again for the
      // focus a click leaves behind strands it open under the cursor after the
      // click, so only keyboard focus opens it.
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.target.matches(":focus-visible")) show();
      },
      onBlur: () => setOpen(false),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape" || !visible) return;
        event.stopPropagation();
        setDismissed(true);
      },
    },
    tip: visible
      ? <span className={placement === "below-end" ? "tooltip end" : "tooltip"} role="tooltip" id={id}>{text}</span>
      : null,
  };
}
