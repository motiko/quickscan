'use client';

export type Tool = 'select' | 'pen' | 'highlighter' | 'rect' | 'arrow' | 'text' | 'signature';

export const INK_COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a'];
export const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa'];

const COLOR_NAMES: Record<string, string> = {
  '#111827': 'black',
  '#2563eb': 'blue',
  '#dc2626': 'red',
  '#16a34a': 'green',
  '#facc15': 'yellow',
  '#4ade80': 'green',
  '#f472b6': 'pink',
  '#60a5fa': 'blue',
};

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';

const ICON_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  {
    id: 'select',
    label: 'Select',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 4l7 17 2.5-7.5L21 11z" />
      </svg>
    ),
  },
  {
    id: 'pen',
    label: 'Pen',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </svg>
    ),
  },
  {
    id: 'highlighter',
    label: 'Highlight', // "Highlighter" leaves no gap to its neighbours at 360 px
    icon: (
      <svg {...ICON_PROPS}>
        <path d="m9 11-6 6v3h9l3-3" />
        <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
      </svg>
    ),
  },
  {
    id: 'rect',
    label: 'Rectangle',
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="5" width="18" height="14" rx="1" />
      </svg>
    ),
  },
  {
    id: 'arrow',
    label: 'Arrow',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M5 19 19 5" />
        <path d="M9 5h10v10" />
      </svg>
    ),
  },
  {
    id: 'text',
    label: 'Text',
    icon: (
      <svg {...ICON_PROPS}>
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
  },
  {
    id: 'signature',
    label: 'Signature',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 17c3-1 4-9 6-9s-1 9 1 9 3-5 4-5 1 4 3 4 2-2 4-2" />
        <line x1="3" y1="21" x2="21" y2="21" />
      </svg>
    ),
  },
];

interface AnnotationToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  color: string;
  colors: string[];
  onColorChange: (color: string) => void;
  sizeIndex: number;
  onSizeChange: (index: number) => void;
}

export function AnnotationToolbar({
  tool,
  onToolChange,
  color,
  colors,
  onColorChange,
  sizeIndex,
  onSizeChange,
}: AnnotationToolbarProps) {
  return (
    <div className="border-t border-white/10 bg-neutral-900 px-safe-offset-3 pt-1 pb-safe-offset-2">
      {/* Hit areas are 44 px (UX-001); the swatches and dots inside stay small */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3">
        <div className="flex items-center" role="group" aria-label="Colors">
          {colors.map((c) => (
            <button
              key={c}
              onClick={() => onColorChange(c)}
              aria-label={`Color ${COLOR_NAMES[c] ?? c}`}
              aria-pressed={c === color}
              className={focusRing + ' flex h-11 w-11 items-center justify-center rounded-full'}
            >
              <span
                aria-hidden="true"
                // The ring keeps dark ink visible on the dark toolbar (UX-005, 3:1 for UI boundaries)
                className={`h-7 w-7 rounded-full border border-white/50 ${
                  c === color ? 'ring-2 ring-white ring-offset-2 ring-offset-neutral-900' : ''
                }`}
                style={{ backgroundColor: c }}
              />
            </button>
          ))}
        </div>
        <div className="flex items-center" role="group" aria-label="Size">
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              onClick={() => onSizeChange(i)}
              aria-label={['Small', 'Medium', 'Large'][i]}
              aria-pressed={i === sizeIndex}
              className={`${focusRing} flex h-11 w-11 items-center justify-center rounded-full ${
                i === sizeIndex ? 'bg-white/20' : 'hover:bg-white/10'
              }`}
            >
              <span aria-hidden="true" className="rounded-full bg-gray-200" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
            </button>
          ))}
        </div>
      </div>
      {/* Fits 7 × 44 px at 360 px; scrolls rather than clipping with large text (UX-010) */}
      <div className="flex items-stretch overflow-x-auto" role="toolbar" aria-label="Annotation tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => onToolChange(t.id)}
            aria-pressed={t.id === tool}
            className={`${focusRing} flex min-h-11 flex-1 shrink-0 flex-col items-center justify-center rounded-lg py-1 text-[0.625rem] font-medium ${
              t.id === tool ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            <span aria-hidden="true">{t.icon}</span>
            <span className="mt-0.5 min-w-11 whitespace-nowrap text-center">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
