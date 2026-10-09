'use client';

import { Heart } from './icons';
import { cn } from '@/lib/utils';

export function FavoriteButton({ favorite, busy, onClick, variant = 'tile' }: {
  favorite: boolean;
  busy: boolean;
  onClick: () => void;
  variant?: 'tile' | 'viewer';
}) {
  const label = favorite ? 'Remove from favorites' : 'Add to favorites';
  return <button type="button" data-favorite-action aria-label={label} title={label} aria-pressed={favorite}
    aria-busy={busy || undefined} disabled={busy}
    onClick={event => { event.stopPropagation(); onClick(); }}
    className={cn('grid shrink-0 place-items-center transition-colors disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-volt',
      variant === 'tile' ? 'size-8 rounded-full bg-black/65 text-white hover:bg-black/85' : 'size-11 rounded-xl bg-white/[0.06] text-ink-2 hover:bg-white/[0.11] hover:text-ink')}>
    <Heart variant={favorite ? 'Bold' : 'Linear'} className={cn(variant === 'tile' ? 'size-4' : 'size-[18px]', favorite && 'text-hot')} strokeWidth={1.8} />
  </button>;
}
