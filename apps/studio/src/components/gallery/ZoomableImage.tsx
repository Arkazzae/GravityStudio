"use client";

import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { LoaderCircle, Scan, ZoomIn, ZoomOut } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import styles from "./ZoomableImage.module.css";

const LEVELS = [1, 1.5, 2, 3, 4, 6, 8];
type ImageProps = Pick<ImgHTMLAttributes<HTMLImageElement>, "alt" | "className" | "onError" | "referrerPolicy"> & { src: string };

/** Zoom and pan for saved images opened from the studio gallery. */
export function ZoomableImage(props: ImageProps) {
  return <ImageViewport key={props.src} {...props} />;
}

function ImageViewport({ src, alt, className, onError, referrerPolicy }: ImageProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const loading = !!src && !failed && natural.width === 0;
  const ready = !failed && natural.width > 0 && size.width > 0 && size.height > 0;
  const fit = ready ? Math.min(size.width / natural.width, size.height / natural.height) : 1;
  const width = natural.width * fit * zoom;
  const height = natural.height * fit * zoom;

  useLayoutEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current && viewport.current) {
      viewport.current.scrollTo(pendingScroll.current);
      pendingScroll.current = null;
    }
  }, [zoom]);

  function changeZoom(next: number, point = { x: size.width / 2, y: size.height / 2 }) {
    const element = viewport.current;
    if (!element || !ready || next === zoom) return;
    // Keep the point being inspected under the pointer (or at the view's center).
    const x = (element.scrollLeft + point.x - Math.max(0, (size.width - width) / 2)) / width;
    const y = (element.scrollTop + point.y - Math.max(0, (size.height - height) / 2)) / height;
    const nextWidth = natural.width * fit * next, nextHeight = natural.height * fit * next;
    pendingScroll.current = {
      left: Math.max(0, (size.width - nextWidth) / 2) + x * nextWidth - point.x,
      top: Math.max(0, (size.height - nextHeight) / 2) + y * nextHeight - point.y,
    };
    setZoom(next);
  }
  function step(direction: number) {
    changeZoom(LEVELS[Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(zoom) + direction))]);
  }

  return <div className={cn(styles.frame, className)} data-photo-action onKeyDown={event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); event.stopPropagation(); step(1); }
    else if (event.key === "-") { event.preventDefault(); event.stopPropagation(); step(-1); }
    else if (event.key === "0" || event.key === "Escape" && zoom > 1) { event.preventDefault(); event.stopPropagation(); changeZoom(1); }
    else if (zoom > 1 && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      viewport.current?.scrollBy({ left: event.key === "ArrowLeft" ? -80 : event.key === "ArrowRight" ? 80 : 0, top: event.key === "ArrowUp" ? -80 : event.key === "ArrowDown" ? 80 : 0 });
    }
  }}>
    <div ref={viewport} className={styles.viewport} data-dialog-scroll data-zoomed={zoom > 1} data-dragging={dragging} tabIndex={0} role="region" aria-label="Image zoom and pan" aria-busy={loading}
      onDoubleClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        changeZoom(zoom === 1 ? 2 : 1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      }}
      onPointerDown={event => {
        if (zoom === 1 || event.button !== 0 || event.pointerType === "touch") return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        event.currentTarget.scrollTo({ left: start.left + start.x - event.clientX, top: start.top + start.y - event.clientY });
      }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}>
      <div className={styles.canvas} style={ready ? { width: Math.max(size.width, width), height: Math.max(size.height, height) } : undefined}>
        <img src={src} alt={alt} referrerPolicy={referrerPolicy} draggable={false} decoding="async"
          onError={event => { setFailed(true); onError?.(event); }}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={ready ? { width, height } : { visibility: "hidden" }} />
      </div>
    </div>
    {loading && <div className={styles.loading} role="status" aria-label="Loading image">
      <LoaderCircle size={30} strokeWidth={1.8} aria-hidden="true" />
    </div>}
    {zoom > 1 && <span className={styles.hint}>Drag to move</span>}
    <div className={styles.controls} role="group" aria-label="Image zoom controls">
      <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={!ready || zoom === 1} onClick={() => step(-1)}><ZoomOut size={18} /></button>
      <span className={styles.level} role="status" aria-label="Zoom level">{zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
      <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={!ready || zoom === LEVELS.at(-1)} onClick={() => step(1)}><ZoomIn size={18} /></button>
      <span className={styles.divider} />
      <button type="button" aria-label="Reset zoom" title="Fit image (0)" disabled={!ready || zoom === 1} onClick={() => changeZoom(1)}><Scan size={18} /></button>
    </div>
  </div>;
}
