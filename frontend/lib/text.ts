import { Stroke } from './useStore';

export const DEFAULT_TEXT_WIDTH = 240;
export const TEXT_LINE_HEIGHT = 1.2;

export function getTextFontStyle(bold: boolean, italic: boolean): string {
  return [bold ? 'bold' : '', italic ? 'italic' : ''].filter(Boolean).join(' ') || 'normal';
}

export function measureTextHeight(text: string, fontSize: number, width = DEFAULT_TEXT_WIDTH): number {
  const averageCharacterWidth = fontSize * 0.55;
  const charactersPerLine = Math.max(1, Math.floor(width / averageCharacterWidth));
  const visualLines = (text || ' ').split('\n').reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0
  );
  return Math.max(fontSize * TEXT_LINE_HEIGHT, visualLines * fontSize * TEXT_LINE_HEIGHT);
}

export function getTextLocalRect(stroke: Stroke) {
  const width = stroke.textWidth ?? DEFAULT_TEXT_WIDTH;
  const height = stroke.textHeight ?? measureTextHeight(stroke.text ?? '', stroke.fontSize ?? 24, width);
  return { width, height };
}
