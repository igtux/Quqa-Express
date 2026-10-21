/** Inline icons (stroke style, 24×24). */
const PATHS = {
  terminal: 'M4 17l6-6-6-6M12 19h8',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  close: 'M18 6L6 18M6 6l12 12',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  key: 'M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0 1 15 7z',
  warning: 'M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  splitH: 'M3 4h18v16H3zM12 4v16',
  splitV: 'M3 4h18v16H3zM3 12h18',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  bellOff:
    'M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17 17 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M2 2l20 20',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.4-4.4',
  palette:
    'M12 3a9 9 0 0 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.1-1-1.4-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5zM7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01',
  maximize: 'M8 3H3v5M21 8V3h-5M16 21h5v-5M3 16v5h5',
  layers: 'M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  import: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  arrowDown: 'M12 5v14M5 12l7 7 7-7',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className,
  filled,
}: {
  name: IconName;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
