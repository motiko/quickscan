import { describe, expect, it } from 'vitest';
import { fromBytea, toBytea } from '@/lib/bytea';

describe('bytea hex format', () => {
  it('writes \\x + lowercase hex and reads it back', () => {
    const bytes = Uint8Array.from([0, 1, 0x0f, 0xab, 0xff]);
    expect(toBytea(bytes)).toBe('\\x00010fabff');
    expect(fromBytea('\\x00010fabff')).toEqual(bytes);
    expect(fromBytea('\\x00010FABFF')).toEqual(bytes);
    expect(fromBytea(toBytea(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('refuses anything that is not a bytea hex string', () => {
    expect(() => fromBytea('00010f')).toThrow(TypeError);
    expect(() => fromBytea('\\x0')).toThrow(TypeError);
    expect(() => fromBytea('\\xzz')).toThrow(TypeError);
    expect(() => fromBytea(null)).toThrow(TypeError);
  });
});
