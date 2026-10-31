import pino, { type DestinationStream, type Logger } from 'pino';

const SENSITIVE_KEYS = ['req', 'res', 'err', 'error', 'body', 'query', 'params', 'headers', 'authorization', 'cookie'];

export function createLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: 'info',
      redact: { paths: [...SENSITIVE_KEYS, ...SENSITIVE_KEYS.map((key) => `*.${key}`)], censor: '[redacted]' },
    },
    destination,
  );
}
