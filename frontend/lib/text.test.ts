import { describe, expect, it } from 'vitest';
import { getTextFontStyle, measureTextHeight, TEXT_LINE_HEIGHT } from './text';

describe('text model helpers', () => {
  it('combines bold and italic styles for Konva', () => {
    expect(getTextFontStyle(false, false)).toBe('normal');
    expect(getTextFontStyle(true, false)).toBe('bold');
    expect(getTextFontStyle(false, true)).toBe('italic');
    expect(getTextFontStyle(true, true)).toBe('bold italic');
  });

  it('grows text height for explicit and wrapped lines', () => {
    expect(measureTextHeight('hello', 20, 240)).toBe(20 * TEXT_LINE_HEIGHT);
    expect(measureTextHeight('first\nsecond', 20, 240)).toBe(40 * TEXT_LINE_HEIGHT);
    expect(measureTextHeight('abcdefghij', 20, 44)).toBe(60 * TEXT_LINE_HEIGHT);
  });
});
