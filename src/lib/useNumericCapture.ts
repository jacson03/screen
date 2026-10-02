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

interface PreparedFrame {
  textCanvas: HTMLCanvasElement;
  numberCanvas: HTMLCanvasElement;
  redPixelRatio: number;
}

function prepareFrame(source: HTMLCanvasElement): PreparedFrame {
  const scale = 3;
  const textCanvas = document.createElement('canvas');
  const numberCanvas = document.createElement('canvas');
  textCanvas.width = source.width * scale;
  textCanvas.height = source.height * scale;
  numberCanvas.width = textCanvas.width;
  numberCanvas.height = textCanvas.height;

  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  const textContext = textCanvas.getContext('2d', { willReadFrequently: true });
  const numberContext = numberCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext || !textContext || !numberContext) {
    return { textCanvas: source, numberCanvas: source, redPixelRatio: 0 };
  }

  textContext.imageSmoothingEnabled = false;
  textContext.drawImage(source, 0, 0, textCanvas.width, textCanvas.height);
  numberContext.fillStyle = '#000';
  numberContext.fillRect(0, 0, numberCanvas.width, numberCanvas.height);

  const image = sourceContext.getImageData(0, 0, source.width, source.height);
  const redMask = numberContext.createImageData(numberCanvas.width, numberCanvas.height);
  let redPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    const isRed = red >= 120 && red > green * 1.35 && red > blue * 1.25;
    if (!isRed) continue;
    redPixels += 1;
    const sourceX = (index / 4) % source.width;
    const sourceY = Math.floor(index / 4 / source.width);
    for (let y = 0; y < scale; y += 1) {
      for (let x = 0; x < scale; x += 1) {
        const targetIndex = ((sourceY * scale + y) * numberCanvas.width + sourceX * scale + x) * 4;
        redMask.data[targetIndex] = 255;
        redMask.data[targetIndex + 1] = 255;
        redMask.data[targetIndex + 2] = 255;
        redMask.data[targetIndex + 3] = 255;
      }
    }
  }
  numberContext.putImageData(redMask, 0, 0);

  return {
    textCanvas,
    numberCanvas,
    redPixelRatio: redPixels / (source.width * source.height),
  };
}

function normalizeOcrText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
}

function hasExactTrigger(text: string): boolean {
  return /(^| )FLEW AWAY( |$)/.test(normalizeOcrText(text));
}

export function useNumericCapture() {
  const [events, setEvents] = useState<CapturedNumber[]>([]);
  const [processing, setProcessing] = useState(false);
  const textWorkerRef = useRef<Worker | null>(null);
  const numberWorkerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startedAtRef = useRef(0);
  const lastCapturedValueRef = useRef<string | null>(null);
  const pendingValueRef = useRef<{ value: string; matches: number } | null>(null);
  const busyRef = useRef(false);

  const clearEvents = useCallback(() => {
    setEvents([]);
    lastCapturedValueRef.current = null;
    pendingValueRef.current = null;
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

      if (!textWorkerRef.current) {
        textWorkerRef.current = await createWorker('eng');
        await textWorkerRef.current.setParameters({
          tessedit_pageseg_mode: PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
        });
      }
      if (!numberWorkerRef.current) {
        numberWorkerRef.current = await createWorker('eng');
        await numberWorkerRef.current.setParameters({
          tessedit_char_whitelist: '0123456789.,+-xX',
          tessedit_pageseg_mode: PSM.SINGLE_LINE,
          preserve_interword_spaces: '1',
        });
      }

      const scan = async () => {
        if (busyRef.current || !canvasRef.current || !textWorkerRef.current || !numberWorkerRef.current) return;
        busyRef.current = true;
        try {
          const frame = prepareFrame(canvasRef.current);
          if (frame.redPixelRatio < 0.002) {
            pendingValueRef.current = null;
            return;
          }

          const [textResult, redResult, textNumberResult] = await Promise.all([
            textWorkerRef.current.recognize(frame.textCanvas),
            numberWorkerRef.current.recognize(frame.numberCanvas),
            numberWorkerRef.current.recognize(frame.textCanvas),
          ]);
          const textConfidence = textResult.data.confidence ?? 0;
          const numberConfidence = Math.min(
            redResult.data.confidence ?? 0,
            textNumberResult.data.confidence ?? 0,
          );
          if (!hasExactTrigger(textResult.data.text) || textConfidence < 70 || numberConfidence < 70) {
            pendingValueRef.current = null;
            return;
          }

          const redValue = extractNumber(redResult.data.text);
          const textValue = extractNumber(textNumberResult.data.text);
          if (!redValue || redValue !== textValue || !Number.isFinite(Number(redValue))) {
            pendingValueRef.current = null;
            return;
          }

          const previous = pendingValueRef.current;
          const matches = previous?.value === redValue ? previous.matches + 1 : 1;
          pendingValueRef.current = { value: redValue, matches };
          if (matches < 2 || redValue === lastCapturedValueRef.current) return;

          lastCapturedValueRef.current = redValue;
          const now = Date.now();
          setEvents((previousEvents) => [
            ...previousEvents,
            {
              value: redValue,
              numeric_value: Number(redValue),
              captured_at: new Date(now).toISOString(),
              elapsed_ms: now - startedAtRef.current,
              confidence: Math.min(textConfidence, numberConfidence),
              source: 'ocr',
            },
          ]);
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
      if (textWorkerRef.current) {
        void textWorkerRef.current.terminate();
      }
      if (numberWorkerRef.current) {
        void numberWorkerRef.current.terminate();
      }
    };
  }, [stop]);

  return { events, processing, start, stop, clearEvents };
}
