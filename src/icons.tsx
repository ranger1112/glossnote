import type { SVGProps } from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

function iconProps(size: number, className?: string): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    className,
  };
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  );
}

export function IconUpload({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

export function IconDownload({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

export function IconBookmark({
  size = 16,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...iconProps(size, className)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

export function IconHistory({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
      <path d="M4.5 9.5 3 8m1.5 1.5L6 7.5" />
    </svg>
  );
}

export function IconList({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

export function IconPages({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <rect x="3.5" y="4" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="4" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13" width="7" height="7" rx="1.2" />
    </svg>
  );
}

export function IconTrash({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconPencil({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m13.5 6.5 3 3" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.3a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.7 9c.14.38.53.63 1.03.63H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.37Z" />
    </svg>
  );
}

export function IconKeyboard({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13h.01M10 13h.01M13 13h.01M16 13h.01M8 16h8" />
    </svg>
  );
}

export function IconStar({
  size = 16,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...iconProps(size, className)} fill={filled ? 'currentColor' : 'none'}>
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" />
    </svg>
  );
}

export function IconUndo({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  );
}

export function IconRedo({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </svg>
  );
}

export function IconSparkles({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
    </svg>
  );
}

export function IconSun({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
    </svg>
  );
}

export function IconMoon({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function IconArrowLeft({ size = 16, className }: IconProps) {
  return (
    <svg {...iconProps(size, className)}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </svg>
  );
}
