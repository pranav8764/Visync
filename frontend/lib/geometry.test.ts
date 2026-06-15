import { describe, expect, it } from 'vitest';
import { getStrokeAABB, strokeIntersectsEraser, strokeIntersectsRect } from './geometry';
import { Stroke } from './useStore';

const textStroke: Stroke = {
  id: 'text-1',
  userId: 'user-1',
  tool: 'text',
  points: [{ x: 100, y: 80 }],
  x: 100,
  y: 80,
  color: '#000000',
  strokeWidth: 0,
  text: 'Hello',
  textWidth: 200,
  textHeight: 40,
  fontSize: 24,
  fontFamily: 'Arial',
};

describe('text shape geometry', () => {
  it('uses text dimensions and transforms for its bounding box', () => {
    expect(getStrokeAABB(textStroke)).toEqual({ x: 100, y: 80, width: 200, height: 40 });

    const rotated = getStrokeAABB({ ...textStroke, scaleX: 2, rotation: 90 });
    expect(rotated.x).toBeCloseTo(60);
    expect(rotated.y).toBeCloseTo(80);
    expect(rotated.width).toBeCloseTo(40);
    expect(rotated.height).toBeCloseTo(400);
  });

  it('supports marquee selection and object erasing', () => {
    expect(strokeIntersectsRect(textStroke, { x: 90, y: 70, width: 30, height: 30 })).toBe(true);
    expect(strokeIntersectsRect(textStroke, { x: 400, y: 400, width: 30, height: 30 })).toBe(false);

    expect(strokeIntersectsEraser(textStroke, { x1: 130, y1: 90, x2: 150, y2: 90 }, 8)).toBe(true);
    expect(strokeIntersectsEraser(textStroke, { x1: 400, y1: 400, x2: 420, y2: 420 }, 8)).toBe(false);
  });
});
