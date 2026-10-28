import { describe, expect, it } from 'vitest';
import { simplifyPath } from './simplify';

describe('simplifyPath (RDP)', () => {
  it('returns short paths unchanged', () => {
    const p = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
    expect(simplifyPath(p)).toBe(p);
  });

  it('collapses collinear points to the endpoints', () => {
    const p = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i }));
    expect(simplifyPath(p, 1)).toEqual([p[0], p[19]]);
  });

  it('keeps a corner that exceeds the tolerance and drops one inside it', () => {
    const corner = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }];
    expect(simplifyPath(corner, 1)).toHaveLength(3);
    const flat = [{ x: 0, y: 0 }, { x: 10, y: 0.5 }, { x: 20, y: 0 }];
    expect(simplifyPath(flat, 1)).toHaveLength(2);
  });

  it('always keeps the first and last point', () => {
    const p = Array.from({ length: 50 }, (_, i) => ({ x: i, y: Math.sin(i / 3) * 10 }));
    const out = simplifyPath(p, 2);
    expect(out[0]).toEqual(p[0]);
    expect(out[out.length - 1]).toEqual(p[49]);
  });
});
