'use client';

import { forwardRef, type CSSProperties, type SVGProps } from 'react';
import {
  Activity as ActivityIcon, Add, ArrowDown2, ArrowRight as ArrowRightIcon, ArrowRight2, ArrowRotateLeft,
  Box, Category, Clock, Copy as CopyIcon, Cpu as CpuIcon, Driver2, Eye as EyeIcon, EyeSlash,
  Gallery, Grid3, Import, InfoCircle as InfoCircleIcon, Layer, Logout, MessageQuestion,
  Refresh, RepeateMusic, Scan as ScanIcon, SearchNormal1, Setting2, Setting4,
  Shuffle as ShuffleIcon, Status, TickCircle, Trash, User, Warning2, type Icon,
} from 'iconsax-reactjs';
import { cn } from '@/lib/utils';
import styles from './icons.module.css';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

/** Semantic names keep the interface independent of the icon package's naming. */
function icon(Component: Icon, name: string, rotation?: number) {
  const StudioIcon = forwardRef<SVGSVGElement, IconProps>(function StudioIcon({ size = 24, strokeWidth, className, style, ...props }, ref) {
    const appearance = {
      ...(strokeWidth !== undefined ? { '--studio-icon-stroke-width': strokeWidth } : {}),
      ...(rotation !== undefined ? { transform: `rotate(${rotation}deg)` } : {}),
      ...style,
    } as CSSProperties;
    return <Component aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true} focusable="false"
      {...props} ref={ref} variant="Linear" size={size} strokeWidth={strokeWidth}
      className={cn(strokeWidth !== undefined && styles.strokeWidth, className)} style={appearance} />;
  });
  StudioIcon.displayName = name;
  return StudioIcon;
}

export const Activity = /* @__PURE__ */ icon(ActivityIcon, 'Activity');
export const ArrowRight = /* @__PURE__ */ icon(ArrowRightIcon, 'ArrowRight');
export const Boxes = /* @__PURE__ */ icon(Box, 'Boxes');
export const Check = /* @__PURE__ */ icon(TickCircle, 'Check');
export const ChevronDown = /* @__PURE__ */ icon(ArrowDown2, 'ChevronDown');
export const ChevronRight = /* @__PURE__ */ icon(ArrowRight2, 'ChevronRight');
export const CircleHelp = /* @__PURE__ */ icon(MessageQuestion, 'CircleHelp');
export const Clock3 = /* @__PURE__ */ icon(Clock, 'Clock3');
export const Copy = /* @__PURE__ */ icon(CopyIcon, 'Copy');
export const Cpu = /* @__PURE__ */ icon(CpuIcon, 'Cpu');
export const Download = /* @__PURE__ */ icon(Import, 'Download');
export const Eye = /* @__PURE__ */ icon(EyeIcon, 'Eye');
export const EyeOff = /* @__PURE__ */ icon(EyeSlash, 'EyeOff');
export const HardDrive = /* @__PURE__ */ icon(Driver2, 'HardDrive');
export const ImageIcon = /* @__PURE__ */ icon(Gallery, 'ImageIcon');
export const InfoCircle = /* @__PURE__ */ icon(InfoCircleIcon, 'InfoCircle');
export const Layers2 = /* @__PURE__ */ icon(Layer, 'Layers2');
export const LayoutGrid = /* @__PURE__ */ icon(Category, 'LayoutGrid');
export const Library = /* @__PURE__ */ icon(Gallery, 'Library');
export const LoaderCircle = /* @__PURE__ */ icon(Status, 'LoaderCircle');
export const LogOut = /* @__PURE__ */ icon(Logout, 'LogOut');
export const Plus = /* @__PURE__ */ icon(Add, 'Plus');
export const RefreshCw = /* @__PURE__ */ icon(Refresh, 'RefreshCw');
export const Repeat2 = /* @__PURE__ */ icon(RepeateMusic, 'Repeat2');
export const RotateCcw = /* @__PURE__ */ icon(ArrowRotateLeft, 'RotateCcw');
export const Rows3 = /* @__PURE__ */ icon(Grid3, 'Rows3');
export const Scan = /* @__PURE__ */ icon(ScanIcon, 'Scan');
export const Search = /* @__PURE__ */ icon(SearchNormal1, 'Search');
export const Settings = /* @__PURE__ */ icon(Setting2, 'Settings');
export const Shuffle = /* @__PURE__ */ icon(ShuffleIcon, 'Shuffle');
export const SlidersHorizontal = /* @__PURE__ */ icon(Setting4, 'SlidersHorizontal');
export const Trash2 = /* @__PURE__ */ icon(Trash, 'Trash2');
export const TriangleAlert = /* @__PURE__ */ icon(Warning2, 'TriangleAlert');
export const UserRound = /* @__PURE__ */ icon(User, 'UserRound');
export const X = /* @__PURE__ */ icon(Add, 'X', 45);
