'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { Annotation, Page, Point, Signature } from '@/types';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { useAnnotationHistory } from '@/hooks/useAnnotationHistory';
import { drawAnnotations, canvasMeasure, textFont, type SignatureImages } from '@/lib/annotations/render';
import {
  getBounds,
  hitTest,
  isResizable,
  resizeAnnotation,
  translateAnnotation,
  TEXT_LINE_HEIGHT,
} from '@/lib/annotations/geometry';
import { loadSignatureImages } from '@/lib/annotations/flatten';
import { AnnotationToolbar, INK_COLORS, HIGHLIGHT_COLORS, type Tool } from './AnnotationToolbar';
import { SignaturePad } from './SignaturePad';

interface AnnotationEditorProps {
  page: Page;
  onSave: (annotations: Annotation[]) => Promise<void> | void;
  onCancel: () => void;
}

// Sizes per tool, as fractions of the image width
const STROKE_WIDTHS = [0.003, 0.006, 0.012];
const HIGHLIGHT_WIDTHS = [0.02, 0.03, 0.045];
const FONT_SIZES = [0.03, 0.045, 0.065];
const HIT_TOLERANCE_CSS_PX = 12;
const HANDLE_CSS_PX = 10;
const MIN_SHAPE_CSS_PX = 6;

interface TextEdit {
  id: string | null; // null for a new text box
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
}

type Drag =
  | { kind: 'draw' }
  | { kind: 'move'; start: Point; origin: Annotation; moved: boolean; wasSelected: boolean }
  | { kind: 'resize'; origin: Annotation };

function annotationColor(a: Annotation): string | null {
  return a.type === 'signature' ? null : a.color;
}

export function AnnotationEditor({ page, onSave, onCancel }: AnnotationEditorProps) {
  const baseUrl = useBlobUrl(page.processedBlob || page.originalBlob);
  const history = useAnnotationHistory(page.annotations ?? []);

  const [tool, setTool] = useState<Tool>('pen');
  const [inkColor, setInkColor] = useState(INK_COLORS[0]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [sizeIndex, setSizeIndex] = useState(1);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [preview, setPreview] = useState<Annotation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [signatureImages, setSignatureImages] = useState<SignatureImages>(new Map());
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<Drag | null>(null);

  const annotations = preview ?? history.annotations;
  const selected = annotations.find((a) => a.id === selectedId) ?? null;
  const color = tool === 'highlighter' ? highlightColor : inkColor;

  // Fit the page into the available space
  const display =
    imageSize && containerSize
      ? (() => {
          const scale = Math.min(containerSize.width / imageSize.width, containerSize.height / imageSize.height);
          return { width: Math.floor(imageSize.width * scale), height: Math.floor(imageSize.height * scale) };
        })()
      : null;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Load images for any signatures on the page
  const signatureKey = annotations
    .flatMap((a) => (a.type === 'signature' ? [a.signatureId] : []))
    .sort()
    .join(',');
  useEffect(() => {
    let cancelled = false;
    const missing = annotations.filter((a) => a.type === 'signature' && !signatureImages.has(a.signatureId));
    if (missing.length === 0) return;
    loadSignatureImages(missing).then((loaded) => {
      if (!cancelled) setSignatureImages((prev) => new Map([...prev, ...loaded]));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatureKey]);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // Redraw the overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !display) return;
    canvas.width = Math.round(display.width * dpr);
    canvas.height = Math.round(display.height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const visible = annotations.filter((a) => a.id !== textEdit?.id);
    drawAnnotations(ctx, draft ? [...visible, draft] : visible, canvas.width, canvas.height, signatureImages);

    if (selected && selected.id !== textEdit?.id) {
      const b = getBounds(selected, canvas.width, canvas.height, canvasMeasure(ctx));
      const pad = 4 * dpr;
      ctx.save();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      if (isResizable(selected)) {
        const s = HANDLE_CSS_PX * dpr;
        ctx.setLineDash([]);
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(b.x + b.w + pad - s / 2, b.y + b.h + pad - s / 2, s, s);
      }
      ctx.restore();
    }
  }, [annotations, draft, selected, textEdit?.id, display, dpr, signatureImages]);

  const toCanvasPoint = (e: React.PointerEvent): { px: Point; n: Point } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    return { px: { x: nx * canvas.width, y: ny * canvas.height }, n: { x: nx, y: ny } };
  };

  const measure = () => canvasMeasure(canvasRef.current!.getContext('2d')!);

  const commitTextEdit = useCallback(() => {
    if (!textEdit) return;
    const text = textEdit.text.replace(/\s+$/, '');
    const rest = history.annotations.filter((a) => a.id !== textEdit.id);
    if (!text) {
      if (textEdit.id) history.commit(rest);
    } else {
      const annotation: Annotation = {
        id: textEdit.id ?? nanoid(),
        type: 'text',
        x: textEdit.x,
        y: textEdit.y,
        text,
        fontSize: textEdit.fontSize,
        color: textEdit.color,
      };
      if (textEdit.id) {
        history.commit(history.annotations.map((a) => (a.id === textEdit.id ? annotation : a)));
      } else {
        history.commit([...history.annotations, annotation]);
      }
      setSelectedId(annotation.id);
    }
    setTextEdit(null);
  }, [textEdit, history]);

  useEffect(() => {
    if (textEdit) setTimeout(() => textAreaRef.current?.focus(), 0);
  }, [textEdit?.id, textEdit !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (textEdit) {
      commitTextEdit();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const { px, n } = toCanvasPoint(e);
    const canvas = canvasRef.current!;

    switch (tool) {
      case 'pen':
      case 'highlighter':
        setSelectedId(null);
        dragRef.current = { kind: 'draw' };
        setDraft({
          id: nanoid(),
          type: 'stroke',
          tool,
          points: [n],
          color,
          width: (tool === 'pen' ? STROKE_WIDTHS : HIGHLIGHT_WIDTHS)[sizeIndex],
        });
        break;
      case 'rect':
        setSelectedId(null);
        dragRef.current = { kind: 'draw' };
        setDraft({ id: nanoid(), type: 'rect', x: n.x, y: n.y, w: 0, h: 0, color, width: STROKE_WIDTHS[sizeIndex] });
        break;
      case 'arrow':
        setSelectedId(null);
        dragRef.current = { kind: 'draw' };
        setDraft({
          id: nanoid(),
          type: 'arrow',
          x1: n.x,
          y1: n.y,
          x2: n.x,
          y2: n.y,
          color,
          width: STROKE_WIDTHS[sizeIndex],
        });
        break;
      case 'text':
        setSelectedId(null);
        setTextEdit({ id: null, x: n.x, y: n.y, text: '', fontSize: FONT_SIZES[sizeIndex], color: inkColor });
        break;
      case 'select': {
        if (selected && isResizable(selected)) {
          const b = getBounds(selected, canvas.width, canvas.height, measure());
          const pad = 4 * dpr;
          const hx = b.x + b.w + pad;
          const hy = b.y + b.h + pad;
          if (Math.hypot(px.x - hx, px.y - hy) <= (HANDLE_CSS_PX + 8) * dpr) {
            dragRef.current = { kind: 'resize', origin: selected };
            return;
          }
        }
        const hit = hitTest(annotations, px, canvas.width, canvas.height, HIT_TOLERANCE_CSS_PX * dpr, measure());
        if (hit) {
          dragRef.current = { kind: 'move', start: n, origin: hit, moved: false, wasSelected: hit.id === selectedId };
          setSelectedId(hit.id);
        } else {
          setSelectedId(null);
        }
        break;
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { n } = toCanvasPoint(e);
    const canvas = canvasRef.current!;

    if (drag.kind === 'draw') {
      setDraft((d) => {
        if (!d) return d;
        if (d.type === 'stroke') {
          const last = d.points[d.points.length - 1];
          const dist = Math.hypot((n.x - last.x) * canvas.width, (n.y - last.y) * canvas.height);
          return dist < 2 * dpr ? d : { ...d, points: [...d.points, n] };
        }
        if (d.type === 'arrow') return { ...d, x2: n.x, y2: n.y };
        // x/y stay at the pointer-down anchor; w/h may go negative until pointer up
        if (d.type === 'rect') return { ...d, w: n.x - d.x, h: n.y - d.y };
        return d;
      });
    } else if (drag.kind === 'move') {
      const dx = n.x - drag.start.x;
      const dy = n.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx * canvas.width, dy * canvas.height) < 3 * dpr) return;
      drag.moved = true;
      const moved = translateAnnotation(drag.origin, dx, dy);
      setPreview(history.annotations.map((a) => (a.id === moved.id ? moved : a)));
    } else if (drag.kind === 'resize') {
      // The handle sits just outside the selection box; compensate so the corner tracks the finger
      const resized = resizeAnnotation(
        drag.origin,
        { x: n.x - (4 * dpr) / canvas.width, y: n.y - (4 * dpr) / canvas.height },
        canvas.width,
        canvas.height,
        measure()
      );
      setPreview(history.annotations.map((a) => (a.id === resized.id ? resized : a)));
    }
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const canvas = canvasRef.current!;

    if (drag.kind === 'draw' && draft) {
      let finished: Annotation | null = draft;
      if (draft.type === 'rect') {
        // Normalize negative sizes from dragging up/left
        const x = Math.min(draft.x, draft.x + draft.w);
        const y = Math.min(draft.y, draft.y + draft.h);
        const w = Math.abs(draft.w);
        const h = Math.abs(draft.h);
        finished = w * canvas.width < MIN_SHAPE_CSS_PX * dpr || h * canvas.height < MIN_SHAPE_CSS_PX * dpr
          ? null
          : { ...draft, x, y, w, h };
      } else if (draft.type === 'arrow') {
        const len = Math.hypot((draft.x2 - draft.x1) * canvas.width, (draft.y2 - draft.y1) * canvas.height);
        if (len < MIN_SHAPE_CSS_PX * 2 * dpr) finished = null;
      }
      if (finished) history.commit([...history.annotations, finished]);
      setDraft(null);
    } else if (drag.kind === 'move') {
      if (drag.moved && preview) {
        history.commit(preview);
      } else if (!drag.moved && drag.wasSelected && drag.origin.type === 'text') {
        // Tapping a selected text box edits it
        const t = drag.origin;
        setTextEdit({ id: t.id, x: t.x, y: t.y, text: t.text, fontSize: t.fontSize, color: t.color });
      }
      setPreview(null);
    } else if (drag.kind === 'resize') {
      if (preview) history.commit(preview);
      setPreview(null);
    }
  };

  const handleDeleteSelected = useCallback(() => {
    if (!selectedId) return;
    history.commit(history.annotations.filter((a) => a.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, history]);

  const handleColor = (c: string) => {
    if (tool === 'highlighter') setHighlightColor(c);
    else setInkColor(c);
    if (selected && annotationColor(selected) !== null && annotationColor(selected) !== c) {
      history.commit(history.annotations.map((a) => (a.id === selected.id ? ({ ...a, color: c } as Annotation) : a)));
    }
  };

  const handleTool = (t: Tool) => {
    if (textEdit) commitTextEdit();
    if (t === 'signature') {
      setShowSignaturePad(true);
      return;
    }
    setTool(t);
    if (t !== 'select') setSelectedId(null);
  };

  const handlePickSignature = (signature: Signature) => {
    setShowSignaturePad(false);
    if (!imageSize) return;
    const w = 0.35;
    const h = (w * imageSize.width * (signature.height / signature.width)) / imageSize.height;
    const annotation: Annotation = {
      id: nanoid(),
      type: 'signature',
      signatureId: signature.id,
      x: 0.5 - w / 2,
      y: Math.max(0, 0.5 - h / 2),
      w,
      h,
    };
    createImageBitmap(signature.blob).then((bitmap) =>
      setSignatureImages((prev) => new Map(prev).set(signature.id, bitmap))
    );
    history.commit([...history.annotations, annotation]);
    setTool('select');
    setSelectedId(annotation.id);
  };

  const handleSave = async () => {
    if (textEdit) commitTextEdit();
    setIsSaving(true);
    try {
      await onSave(history.annotations);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (history.isDirty && !window.confirm('Discard your annotation changes?')) return;
    onCancel();
  };

  // Keyboard shortcuts for desktop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textEdit) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        handleDeleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [textEdit, history, selectedId, handleDeleteSelected]);

  const textOverlayStyle = textEdit && display
    ? {
        left: textEdit.x * display.width,
        top: textEdit.y * display.height,
        font: textFont(textEdit.fontSize * display.width),
        lineHeight: TEXT_LINE_HEIGHT,
        color: textEdit.color,
        maxWidth: display.width - textEdit.x * display.width,
      }
    : undefined;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-neutral-950 select-none" role="dialog" aria-label="Annotate page">
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-safe-offset-2">
        <button
          onClick={handleCancel}
          className="rounded-full px-3 py-1.5 text-sm font-semibold text-gray-300 hover:bg-white/10"
        >
          Cancel
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={history.undo}
            disabled={!history.canUndo}
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-200 hover:bg-white/10 disabled:opacity-30"
            aria-label="Undo"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
          <button
            onClick={history.redo}
            disabled={!history.canRedo}
            className="flex h-9 w-9 items-center justify-center rounded-full text-gray-200 hover:bg-white/10 disabled:opacity-30"
            aria-label="Redo"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
            </svg>
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="rounded-full bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Done'}
        </button>
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3">
        {baseUrl && (
          <div className="relative" style={display ? { width: display.width, height: display.height } : { visibility: 'hidden' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={baseUrl}
              alt={`Page ${page.pageNumber}`}
              draggable={false}
              onLoad={(e) =>
                setImageSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
              }
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={`absolute inset-0 h-full w-full touch-none ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}
              aria-label="Annotation canvas"
            />
            {textEdit && textOverlayStyle && (
              <textarea
                ref={textAreaRef}
                value={textEdit.text}
                onChange={(e) => setTextEdit({ ...textEdit, text: e.target.value })}
                onBlur={commitTextEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setTextEdit(null);
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitTextEdit();
                }}
                rows={Math.max(1, textEdit.text.split('\n').length)}
                placeholder="Type…"
                aria-label="Annotation text"
                style={textOverlayStyle}
                className="absolute min-w-[6rem] resize-none overflow-hidden whitespace-pre border border-dashed border-blue-500 bg-white/40 p-0 outline-none"
              />
            )}
          </div>
        )}
      </div>

      <AnnotationToolbar
        tool={tool}
        onToolChange={handleTool}
        color={selected && annotationColor(selected) ? annotationColor(selected)! : color}
        colors={tool === 'highlighter' ? HIGHLIGHT_COLORS : INK_COLORS}
        onColorChange={handleColor}
        sizeIndex={sizeIndex}
        onSizeChange={setSizeIndex}
        hasSelection={!!selected}
        onDeleteSelected={handleDeleteSelected}
      />

      {showSignaturePad && (
        <SignaturePad onPick={handlePickSignature} onClose={() => setShowSignaturePad(false)} />
      )}
    </div>
  );
}
