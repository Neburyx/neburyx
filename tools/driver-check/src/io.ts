export interface Writable {
  write(text: string, done: (error?: Error | null) => void): unknown;
}

/** Resolves when the stream has accepted the text, so the process can exit without cutting it off. */
export function writeAll(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}
