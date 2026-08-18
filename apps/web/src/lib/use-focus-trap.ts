'use client';

import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Only visible elements count — the Rail drawer contains desktop-only
    (`hidden … lg:flex`) elements, and focusing a display:none node is a
    silent no-op that leaves the trap disengaged. */
function isVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility();
  }
  return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
}

/**
 * Dialog behavior for popovers and drawers that claim `role="dialog"`: moves
 * focus inside on open, keeps Tab cycling within visible focusables, closes
 * on Escape (stopping propagation so stacked layers close one at a time), and
 * hands focus back to the trigger on close — unless the close came from the
 * user pointing at another control, which must keep the focus it just took.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose?: () => void,
) {
  // Keep the latest onClose without re-arming the trap on each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active || !ref.current) {
      return;
    }
    const container = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
    (focusables()[0] ?? container).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && onCloseRef.current) {
        // One Escape closes one layer: without stopPropagation, a palette
        // opened from the drawer would take the drawer down with it.
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') {
        return;
      }
      const els = focusables();
      if (els.length === 0) {
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore only when focus is still ours to restore: a click-outside
      // close has already given focus to the clicked control, and yanking it
      // back to the trigger would hijack the user's keystrokes.
      const now = document.activeElement;
      if (now === document.body || (now instanceof Node && container.contains(now))) {
        previous?.focus();
      }
    };
  }, [active, ref]);
}
