'use client';

import { type RefObject, useEffect } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for popovers and drawers that claim `role="dialog"`: moves
 * focus inside on open, keeps Tab cycling within, and hands focus back to the
 * trigger on close. Without it, keyboard users tab straight past the open
 * dialog into the page behind it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) {
      return;
    }
    const container = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? container).focus();

    function onKeyDown(e: KeyboardEvent) {
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
      previous?.focus();
    };
  }, [active, ref]);
}
