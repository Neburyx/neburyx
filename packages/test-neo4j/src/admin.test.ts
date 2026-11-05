import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { guardedDriver } from './admin.js';

const RAW = Object.assign(new Error('Could not connect to secret-host.example.test:7687 as secret-user'), { code: 'ServiceUnavailable' });
const SERVER = Object.assign(new Error('Permission denied for secret-user on secret-database'), { code: 'Neo.ClientError.Security.Forbidden' });

function driverThatFails(error: Error): Driver {
  const fail = async (): Promise<never> => {
    throw error;
  };
  return { session: () => ({ run: fail, close: fail, beginTransaction: async () => ({ run: fail, commit: fail, rollback: fail, close: fail }) }) } as unknown as Driver;
}

const everything = async (driver: Driver): Promise<string[]> => {
  const messages: string[] = [];
  const attempt = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      messages.push(String(error instanceof Error ? `${error.message} ${JSON.stringify(Object.getOwnPropertyNames(error).map((name) => String((error as unknown as Record<string, unknown>)[name])))}` : error));
    }
  };
  const session = guardedDriver(driver).session({ database: 'x' });
  await attempt(() => session.run('RETURN 1'));
  await attempt(() => session.close());
  await attempt(async () => {
    const transaction = await session.beginTransaction({ metadata: { traceId: 't' } });
    await attempt(() => transaction.run('RETURN 1'));
    await attempt(() => transaction.commit());
    await attempt(() => transaction.rollback());
    await attempt(() => transaction.close());
  });
  return messages;
};

describe('the admin connection of a test', () => {
  it('reports every failure with the server code and nothing the driver or the server wrote', async () => {
    for (const error of [RAW, SERVER]) {
      const messages = await everything(driverThatFails(error));
      expect(messages.length).toBe(6);
      for (const message of messages) expect(message).not.toMatch(/secret-/);
    }
    expect((await everything(driverThatFails(SERVER))).every((message) => message.includes('Neo.ClientError.Security.Forbidden'))).toBe(true);
    expect((await everything(driverThatFails(RAW))).every((message) => message.includes('(unknown)'))).toBe(true);
  });

  it('does not repeat the text of a session that cannot be made', () => {
    const driver = { session: () => { throw RAW; } } as unknown as Driver;
    expect(() => guardedDriver(driver).session()).toThrow(/could not open a session/);
    try {
      guardedDriver(driver).session();
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/secret-/);
    }
  });
});
