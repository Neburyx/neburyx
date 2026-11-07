import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { createClientState } from '../state/client-state.js';
import { BannerCauseError, createBannerController, type BannerController, type BannerDescriber, type ServerFailure } from './banner-controller.js';
import { sampleBanner } from './banner-fixtures.js';

function firstAction(banner: BannerController) {
  const found = banner.view.getState().banner?.actions[0];
  if (found === undefined) throw new Error('the banner has no action');
  return found;
}

const failure = (overrides: Partial<ServerFailure> = {}): ServerFailure => ({ code: 'SOURCE_BUSY', message: 'Query MATCH (n) RETURN n timed out for account 12345', retryable: true, traceId: 'trace-1', ...overrides });

const withRetry: BannerDescriber = (_failure, context) => {
  const retry = context.retry('busy', 'Retry');
  return sampleBanner({ id: 'busy', chip: 'Busy', headline: 'The source is busy.', text: 'Nothing was read.', actions: retry === undefined ? [] : [retry] });
};

function open() {
  const banner = createBannerController();
  renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }), createClientState(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, banner);
  return banner;
}

describe('showing a failure on the banner', () => {
  it('shows the described state with a Retry when the describer builds one from the resend function', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    let handled = false;
    act(() => {
      handled = banner.showFailure(failure(), { resend: vi.fn() });
    });
    expect(handled).toBe(true);
    expect(screen.getByText('The source is busy.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it.each(['click', 'enter', 'space'] as const)('dismisses the banner and sends again once when Retry is activated by %s', async (how) => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    const resend = vi.fn();
    act(() => {
      banner.showFailure(failure(), { resend });
    });
    const user = userEvent.setup();
    const retry = screen.getByRole('button', { name: 'Retry' });
    if (how === 'click') await user.click(retry);
    else {
      retry.focus();
      await user.keyboard(how === 'enter' ? '{Enter}' : ' ');
    }
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resend).toHaveBeenCalledWith();
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('puts the focus on the banner region when Retry removes the banner it was pressed in', async () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    act(() => {
      banner.showFailure(failure(), { resend: vi.fn() });
    });
    screen.getByRole('button', { name: 'Retry' }).focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(document.activeElement).toBe(document.querySelector('.banner-region'));
  });

  it('keeps the focus off the page when Retry is replaced by a state with other actions', async () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    act(() => {
      banner.showFailure(failure(), { resend: () => banner.show(sampleBanner({ id: 'running', headline: 'Running again', actions: [{ id: 'cancel', label: 'Cancel', run: () => undefined }] })) });
    });
    screen.getByRole('button', { name: 'Retry' }).focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(document.querySelector('.banner-region'));
  });

  it('keeps a banner that the resend itself shows', async () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    act(() => {
      banner.showFailure(failure(), { resend: () => banner.show(sampleBanner({ id: 'running', headline: 'Running again' })) });
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Running again')).toBeTruthy();
  });

  it('sends once when Retry is activated twice before the screen updates', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    const resend = vi.fn();
    act(() => {
      banner.showFailure(failure(), { resend });
    });
    const retry = firstAction(banner);
    act(() => {
      retry.run();
      retry.run();
    });
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('shows nothing and reports it when the code has no describer', () => {
    const banner = open();
    let handled = true;
    act(() => {
      handled = banner.showFailure(failure({ code: 'SOURCE_UNAVAILABLE' }), { resend: vi.fn() });
    });
    expect(handled).toBe(false);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('shows nothing and reports it when the describer builds nothing', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', () => undefined);
    expect(banner.showFailure(failure())).toBe(false);
  });

  it('refuses a second describer for a code and keeps the first; the function returned takes one out', () => {
    const banner = createBannerController();
    const remove = banner.registerCause('SOURCE_BUSY', withRetry);
    expect(() => banner.registerCause('SOURCE_BUSY', withRetry)).toThrow(BannerCauseError);
    expect(banner.showFailure(failure())).toBe(true);
    remove();
    expect(banner.showFailure(failure())).toBe(false);
    expect(() => banner.registerCause('SOURCE_BUSY', withRetry)).not.toThrow();
  });

  it('exposes a disabled action as disabled and does nothing when it is pressed', async () => {
    const run = vi.fn();
    const banner = open();
    act(() => banner.show(sampleBanner({ actions: [{ id: 'wait', label: 'Retry in 12 s', run, disabled: true }] })));
    const button = screen.getByRole('button', { name: 'Retry in 12 s' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(button);
    expect(run).not.toHaveBeenCalled();
  });

  it('shows the describer\'s copy and none of the server\'s message', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    act(() => {
      banner.showFailure(failure());
    });
    expect(screen.queryByText(/MATCH/)).toBeNull();
    expect(screen.queryByText(/12345/)).toBeNull();
  });

  it('shows no Retry when the describer builds none, even for a retryable failure', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', () => sampleBanner({ id: 'busy', actions: [] }));
    act(() => {
      banner.showFailure(failure({ retryable: true }), { resend: vi.fn() });
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('builds no Retry when the caller gave nothing to send again', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    act(() => {
      banner.showFailure(failure());
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('dismisses first and lets the error out when the resend throws', () => {
    const banner = open();
    banner.registerCause('SOURCE_BUSY', withRetry);
    act(() => {
      banner.showFailure(failure(), {
        resend: () => {
          throw new Error('send failed');
        },
      });
    });
    const retry = firstAction(banner);
    expect(() => retry.run()).toThrow('send failed');
    expect(banner.view.getState().banner).toBeUndefined();
  });
});
