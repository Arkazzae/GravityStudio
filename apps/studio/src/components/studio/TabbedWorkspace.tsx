'use client';
import { Fragment, useLayoutEffect, useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import type { IconProps } from '@/components/ui/icons';
import styles from './TabbedWorkspace.module.css';

export interface WorkspaceSection<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<IconProps>;
  busy?: boolean;
  group?: string;
}

export function TabbedWorkspace<T extends string>({ id, label, sections, selected, onSelect, children }: {
  id: string;
  label: string;
  sections: readonly WorkspaceSection<T>[];
  selected: T;
  onSelect: (section: T) => void;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0;
    const frame = requestAnimationFrame(() => sidebar.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowDown') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowUp') next = (index + sections.length - 1) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault();
    onSelect(sections[next].id);
    document.getElementById(`${id}-tab-${sections[next].id}`)?.focus();
  }

  return <div className={styles.workspace}>
    <nav ref={sidebar} className={styles.sidebar} role="tablist" aria-label={label} aria-orientation="vertical">
      {sections.map(({ id: section, label: title, icon: Icon, busy, group }, index) => <Fragment key={section}>
        {group && sections[index - 1]?.group !== group && <div id={`${id}-group-${encodeURIComponent(group)}`} className={styles.groupHeading} role="presentation" aria-hidden="true"><span>{group}</span></div>}
        <button type="button" role="tab"
        id={`${id}-tab-${section}`} aria-controls={`${id}-panel-${section}`} aria-selected={selected === section}
        aria-describedby={group ? `${id}-group-${encodeURIComponent(group)}` : undefined}
        aria-label={title} title={title} tabIndex={selected === section ? 0 : -1} className={styles.tab}
        onClick={() => onSelect(section)} onKeyDown={event => navigate(event, index)}>
        <Icon size={18} className={busy ? 'animate-spin' : undefined} /><span className={styles.tabLabel}>{title}</span>
      </button></Fragment>)}
    </nav>
    <div ref={content} data-dialog-scroll={selected} className={`${styles.content} @container`}>{children}</div>
  </div>;
}
