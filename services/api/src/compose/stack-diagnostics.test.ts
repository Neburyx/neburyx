import { describe, expect, it } from 'vitest';
import { describeContainers, maskSecrets } from './stack.js';

function inspection(state: Record<string, unknown>, name = '/stack-api-1'): string {
  return JSON.stringify({ Name: name, State: { Status: 'exited', ExitCode: 1, ...state } });
}

function health(output: string, status = 'unhealthy'): Record<string, unknown> {
  return { Health: { Status: status, FailingStreak: 3, Log: [{ Start: '2026-11-03T08:00:00Z', End: '2026-11-03T08:00:05Z', ExitCode: 1, Output: output }] } };
}

describe('masking secrets', () => {
  it('masks the longest value first, so a value that contains another leaves nothing of it behind', () => {
    expect(maskSecrets('login abcdef123456 and abcdef', ['abcdef', 'abcdef123456'])).toBe('login *** and ***');
  });

  it('masks a short value and ignores an empty one', () => {
    expect(maskSecrets('pw=ab1 here', ['ab1', ''])).toBe('pw=*** here');
  });
});

describe('describing containers', () => {
  it('masks a secret in a health check output before the output is shortened, so one that crosses the limit leaves no prefix', () => {
    const secret = 'S3cretValueThatCrossesTheLimit';
    const text = describeContainers([inspection(health(`${'x'.repeat(190)}${secret}`))], [secret]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('S3cretValue');
    expect(text).toContain('***');
  });

  it('masks a secret in the container name and keeps the state, exit code and health', () => {
    const text = describeContainers([inspection(health('refused'), '/stack-hunter2xyz-1')], ['hunter2xyz']);
    expect(text).toBe('stack-***-1: exited, exit code 1, health unhealthy (failing streak 3)\n  last health checks: [exit 1, 2026-11-03T08:00:00Z to 2026-11-03T08:00:05Z] refused');
  });

  it('describes a container with no health check, an empty health log and a null one', () => {
    expect(describeContainers([inspection({})], [])).toBe('stack-api-1: exited, exit code 1');
    expect(describeContainers([inspection({ Health: { Status: 'starting', FailingStreak: 0, Log: [] } })], [])).toBe('stack-api-1: exited, exit code 1, health starting (failing streak 0)');
    expect(describeContainers([inspection({ Health: { Status: 'starting', FailingStreak: 0, Log: null } })], [])).toBe('stack-api-1: exited, exit code 1, health starting (failing streak 0)');
  });

  it('says a container could not be inspected for text that is not JSON or not an inspection, and never throws', () => {
    expect(describeContainers(['not json {', '{"Name": 3}', ''], ['x'])).toBe('container 1: could not be inspected\ncontainer 2: could not be inspected\ncontainer 3: could not be inspected');
  });
});
