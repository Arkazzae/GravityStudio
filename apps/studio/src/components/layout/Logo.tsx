export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden>
      <ellipse
        cx="16"
        cy="16"
        rx="14.2"
        ry="6.4"
        stroke="currentColor"
        strokeWidth="2"
        transform="rotate(-28 16 16)"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="14.2"
        ry="6.4"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.45"
        transform="rotate(32 16 16)"
      />
      <circle cx="16" cy="16" r="4.4" fill="currentColor" />
    </svg>
  );
}
