'use client';

export type Tool = 'select' | 'pen' | 'highlighter' | 'rect' | 'arrow' | 'text' | 'signature';

export const INK_COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a'];
export const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa'];

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
    label: 'Highlighter',
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
  hasSelection: boolean;
  onDeleteSelected: () => void;
}

export function AnnotationToolbar({
  tool,
  onToolChange,
  color,
  colors,
  onColorChange,
  sizeIndex,
  onSizeChange,
  hasSelection,
  onDeleteSelected,
}: AnnotationToolbarProps) {
  return (
    <div className="border-t border-white/10 bg-neutral-900 px-3 pt-2 pb-safe-offset-2">
      <div className="mb-2 flex h-9 items-center justify-between gap-3">
        <div className="flex items-center gap-2" role="group" aria-label="Colors">
          {colors.map((c) => (
            <button
              key={c}
              onClick={() => onColorChange(c)}
              aria-label={`Color ${c}`}
              aria-pressed={c === color}
              className={`h-7 w-7 rounded-full border-2 transition-transform ${
                c === color ? 'scale-110 border-white' : 'border-transparent'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Size">
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              onClick={() => onSizeChange(i)}
              aria-label={['Small', 'Medium', 'Large'][i]}
              aria-pressed={i === sizeIndex}
              className={`flex h-8 w-8 items-center justify-center rounded-full ${
                i === sizeIndex ? 'bg-white/20' : 'hover:bg-white/10'
              }`}
            >
              <span className="rounded-full bg-gray-200" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
            </button>
          ))}
          {hasSelection && (
            <button
              onClick={onDeleteSelected}
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-full text-red-400 hover:bg-white/10"
              aria-label="Delete selected"
            >
              <svg {...ICON_PROPS} width={18} height={18}>
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between" role="toolbar" aria-label="Annotation tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => onToolChange(t.id)}
            aria-label={t.label}
            aria-pressed={t.id === tool}
            className={`flex flex-col items-center rounded-lg px-1.5 py-1 text-[10px] font-medium ${
              t.id === tool ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t.icon}
            <span className="mt-0.5">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
