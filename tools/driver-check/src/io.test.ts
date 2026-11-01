import { describe, expect, it } from 'vitest';
import { writeAll, type Writable } from './io.js';

describe('writeAll', () => {
  it('does not resolve until the stream has accepted the text', async () => {
    let finish: () => void = () => undefined;
    const stream: Writable = { write: (_text, done) => void (finish = () => done()) };
    let resolved = false;
    const written = writeAll(stream, 'report').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    finish();
    await written;
    expect(resolved).toBe(true);
  });

  it('rejects when the stream reports an error', async () => {
    const stream: Writable = { write: (_text, done) => void done(new Error('closed')) };
    await expect(writeAll(stream, 'report')).rejects.toThrow('closed');
  });
});
