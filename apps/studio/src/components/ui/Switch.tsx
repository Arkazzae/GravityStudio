'use client';

import { cn } from '@/lib/utils';

export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
    className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-volt disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none', checked ? 'bg-volt' : 'bg-white/15')}>
    <span aria-hidden="true" className={cn('absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none', checked ? 'left-[22px]' : 'left-0.5')} />
  </button>;
}
