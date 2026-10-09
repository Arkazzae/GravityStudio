'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

function hasFiles(transfer: DataTransfer | null) {
  return !!transfer && (Array.from(transfer.types).includes('Files') || Array.from(transfer.items).some(item => item.kind === 'file'));
}

/** Route external files to the workspace or the active modal, without claiming text drags/pastes. */
export function useFileIntake({ onFiles, enabled = true, dialogRef }: {
  onFiles: (files: File[]) => void;
  enabled?: boolean;
  dialogRef?: RefObject<HTMLDialogElement | null>;
}) {
  const latest = useRef({ onFiles, enabled, dialogRef });
  latest.current = { onFiles, enabled, dialogRef };
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const reset = () => { depth = 0; setDragging(false); };
    const active = () => {
      if (!latest.current.enabled) return false;
      const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));
      const modal = document.activeElement?.closest<HTMLDialogElement>('dialog[open]') || dialogs.at(-1);
      return latest.current.dialogRef ? modal === latest.current.dialogRef.current : !modal;
    };
    const enter = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      if (!active()) { reset(); return; }
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      if (!active()) { reset(); return; }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    };
    const drop = (event: DragEvent) => {
      reset();
      if (!hasFiles(event.dataTransfer) || !active() || event.defaultPrevented) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) latest.current.onFiles(files);
    };
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !active()) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      latest.current.onFiles(files);
    };
    // Window bubbles after document/React targets have had a chance to claim the files.
    // Even an unrelated modal must not let a dropped file replace the Studio page.
    const preventNavigation = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return;
      if (!event.defaultPrevented && event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      event.preventDefault();
    };
    const dialogsChanged = new MutationObserver(reset);
    dialogsChanged.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    document.addEventListener('paste', paste);
    document.addEventListener('dragend', reset);
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    window.addEventListener('blur', reset);
    return () => {
      dialogsChanged.disconnect();
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragover', over);
      document.removeEventListener('drop', drop);
      document.removeEventListener('paste', paste);
      document.removeEventListener('dragend', reset);
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
      window.removeEventListener('blur', reset);
    };
  }, []);

  useEffect(() => { if (!enabled) setDragging(false); }, [enabled]);
  return { dragging: enabled && dragging };
}
