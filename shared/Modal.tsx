import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useTooltip } from "./Tooltip";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The single dialog shell for every modal in the app.
 *
 * It exists because nine hand-copied shells previously shared no code and none
 * of them trapped focus, restored focus on close, or closed on Escape.
 *
 * `dismissOnBackdrop` defaults to false on purpose: a stray click outside a
 * form dialog used to destroy whatever the user had typed, including a password
 * and the word DELETE in the account dialog. Only read-only dialogs opt in.
 */
export function Modal({
  labelledBy,
  className,
  closeDisabled = false,
  dismissOnBackdrop = false,
  confirmDiscard = false,
  onClose,
  children,
}: {
  labelledBy: string;
  className?: string;
  closeDisabled?: boolean;
  dismissOnBackdrop?: boolean;
  /** Ask before discarding: true when the dialog holds unsaved user input. */
  confirmDiscard?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // The close button is an icon with an aria-label and nothing on screen. Say
  // what it does for the people the aria-label does not reach.
  const closeTip = useTooltip("Close this dialog", "below-end");

  /**
   * Escape and the close button used to discard typed input silently. Ask only
   * when there is something to lose: a form dialog whose fields differ from
   * what they were rendered with.
   */
  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (confirmDiscard && dialog) {
      const dirty = Array.from(
        dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
      ).some(field => field.value !== field.defaultValue);
      if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    }
    onClose();
  }, [confirmDiscard, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Remember who opened us so focus can go back there on close.
    const opener = document.activeElement;
    openerRef.current = opener instanceof HTMLElement ? opener : null;

    // Respect an autoFocus that React already honoured; otherwise focus the
    // first meaningful control, falling back to the close button.
    if (!dialog.contains(document.activeElement)) {
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const preferred =
        focusable.find((node) => !node.classList.contains("modal-close")) ??
        focusable[0];
      preferred?.focus();
    }

    return () => openerRef.current?.focus();
  }, []);

  // Escape is bound to the document, not the dialog: a click on the backdrop
  // blurs whatever was focused, and a dialog-scoped handler would then stop
  // receiving keys while the dialog is still open.
  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || closeDisabled) return;
      event.stopPropagation();
      requestClose();
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [closeDisabled, requestClose]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    // Submitting disables the focused button, which sends focus to <body>.
    // Without this branch the next Tab would escape into the page behind.
    if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
       the backdrop is a mouse-only convenience for read-only dialogs; every
       dialog also closes with Escape and with a labelled close button, so the
       keyboard path does not depend on this handler. */
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (dismissOnBackdrop && !closeDisabled) {
          requestClose();
          return;
        }
        // Keep focus inside the dialog instead of letting the click blur it.
        event.preventDefault();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
          a focus trap has to observe Tab on the dialog container itself; the
          interactive controls inside it remain native buttons and inputs. */}
      <div
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <button
          className="modal-close has-tooltip"
          onClick={requestClose}
          aria-label="Close"
          disabled={closeDisabled}
          {...closeTip.triggerProps}
        >
          <Icon name="close" size={18} />
          {closeTip.tip}
        </button>
        {children}
      </div>
    </div>
  );
}
