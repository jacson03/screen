import { useCallback, useEffect, useRef, useState } from 'react';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { CapturedNumber } from '@/lib/types';

function extractNumber(text: string): string | null {
  // OCR commonly inserts spaces around decimal punctuation and confuses a comma
  // with a period. Keep the decimal separator instead of flattening the value.
  const normalized = text
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/\s*([.,])\s*/g, '$1')
    .replace(/[^\d.,+-]/g, '');
  const match = normalized.match(/[+-]?\d+(?:[.,]\d+)?/);
  if (!match) return null;

  const value = match[0].replace(',', '.');
  return /^[-+]?\d+(?:\.\d+)?$/.test(value) ? value : null;
}

function createOcrCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = source.width * scale;
  canvas.height = source.height * scale;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return source;

  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    // Purple overlays have high blue/red relative to green. Make them white
    // and the dark background black so decimal points remain visible to OCR.
    const purple = red > green * 1.15 && blue > green * 1.15;
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    const value = purple ? 255 : luminance > 150 ? 255 : 0;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function useNumericCapture() {
  const [events, setEvents] = useState<CapturedNumber[]>([]);
  const [processing, setProcessing] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startedAtRef = useRef(0);
  const lastValueRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const clearEvents = useCallback(() => {
    setEvents([]);
    lastValueRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    canvasRef.current = null;
    setProcessing(false);
    busyRef.current = false;
  }, []);

  const start = useCallback(
    async (canvas: HTMLCanvasElement, startedAt: number) => {
      stop();
      clearEvents();
      canvasRef.current = canvas;
      startedAtRef.current = startedAt;
      setProcessing(true);

      if (!workerRef.current) {
        workerRef.current = await createWorker('eng');
        await workerRef.current.setParameters({
          tessedit_char_whitelist: '0123456789.,+-',
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
        });
      }

      const scan = async () => {
        if (busyRef.current || !canvasRef.current || !workerRef.current) return;
        busyRef.current = true;
        try {
          const processedCanvas = createOcrCanvas(canvasRef.current);
          const [processedResult, originalResult] = await Promise.all([
            workerRef.current.recognize(processedCanvas),
            workerRef.current.recognize(canvasRef.current),
          ]);
          const candidates = ([processedResult, originalResult]
            .map((result) => ({
              value: extractNumber(result.data.text),
              confidence: result.data.confidence ?? null,
            })) as { value: string | null; confidence: number | null }[])
            .filter((c): c is { value: string; confidence: number | null } => c.value !== null)
            .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
          const candidate = candidates[0];
          if (candidate && candidate.value !== lastValueRef.current) {
            lastValueRef.current = candidate.value;
            const now = Date.now();
            setEvents((previous) => [
              ...previous,
              {
                value: candidate.value,
                numeric_value: Number(candidate.value),
                captured_at: new Date(now).toISOString(),
                elapsed_ms: now - startedAtRef.current,
                confidence: candidate.confidence,
                source: 'ocr',
              },
            ]);
          }
        } finally {
          busyRef.current = false;
        }
      };

      await scan();
      timerRef.current = setInterval(scan, 900);
    },
    [clearEvents, stop]
  );

  useEffect(() => {
    return () => {
      stop();
      if (workerRef.current) {
        void workerRef.current.terminate();
      }
    };
  }, [stop]);

  return { events, processing, start, stop, clearEvents };
}
