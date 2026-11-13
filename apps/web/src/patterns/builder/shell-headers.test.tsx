import { afterEach, describe, expect, it } from 'vitest';
import { settle } from '../patterns-kit.js';
import { builderWorkspace, cleanup, openBuilder, screen, userEvent } from './builder-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the headers of the panel shell', () => {
  it('names the source and says the list is read-only, and in the editor says the pattern is a draft that is not saved', async () => {
    await builderWorkspace();
    expect(screen.getByText(/^Patterns · Source: .+ · read-only$/)).toBeTruthy();
    await openBuilder();
    expect(screen.getByText('New pattern · Draft · not saved')).toBeTruthy();
    expect(screen.queryByText(/read-only$/)).toBeNull();
  });

  it('keeps the draft when the person goes back to the list and returns', async () => {
    await builderWorkspace();
    await openBuilder();
    await userEvent.selectOptions(screen.getByLabelText('Starts at'), 'n-a');
    await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
    await settle();
    expect(screen.getByText(/^Patterns · Source: /)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));
    await settle();
    expect((screen.getByLabelText('Starts at') as HTMLSelectElement).value).toBe('n-a');
  });
});
