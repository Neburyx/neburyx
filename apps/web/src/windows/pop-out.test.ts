import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetOpenedWindows, popOut, popOutAddress, popOutName } from './pop-out.js';

interface FakeWindow {
  closed: boolean;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  location: { href: string };
}

const fakeWindow = (href = '/assistant/inv-1'): FakeWindow => ({ closed: false, focus: vi.fn(), close: vi.fn(), location: { href } });
const asWindow = (fake: FakeWindow | null): Window | null => fake as unknown as Window | null;

afterEach(() => forgetOpenedWindows());

describe('the address and the name', () => {
  it('names the investigation in the address, quoted, and in the name of the window', () => {
    expect(popOutAddress('inv 1/2')).toBe('/assistant/inv%201%2F2');
    expect(popOutName('inv-1')).toBe('neburyx-assistant-inv-1');
  });
});

describe('Pop out', () => {
  it('says it was refused when the browser gives no window, and tries again on the next press', () => {
    const open = vi.fn(() => null);
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true })).toBe('refused');
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true })).toBe('refused');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens the page at the address of the investigation, under the name of the window', () => {
    const open = vi.fn(() => asWindow(fakeWindow()));
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true })).toBe('opened');
    expect(open).toHaveBeenCalledWith('/assistant/inv-1', 'neburyx-assistant-inv-1');
  });

  it('focuses the window it opened on a second press, and neither opens nor navigates', () => {
    const page = fakeWindow();
    const open = vi.fn(() => asWindow(page));
    popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true });
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => true, channelAvailable: () => true })).toBe('focused');
    expect(open).toHaveBeenCalledTimes(1);
    expect(page.focus).toHaveBeenCalledTimes(1);
  });

  it('uses the window it opened for the page again when the person has left the page in it, and focuses it without a channel', () => {
    const page = fakeWindow();
    const open = vi.fn(() => asWindow(page));
    popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true });
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true })).toBe('opened');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('/assistant/inv-1', 'neburyx-assistant-inv-1');
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => false })).toBe('focused');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens a new window when the one it opened has been closed', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const open = vi.fn().mockReturnValueOnce(asWindow(first)).mockReturnValueOnce(asWindow(second));
    popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true });
    first.closed = true;
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true })).toBe('opened');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('finds a page opened otherwise by its name, with no address, and focuses it', () => {
    const page = fakeWindow();
    const open = vi.fn(() => asWindow(page));
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => true, channelAvailable: () => true })).toBe('focused');
    expect(open).toHaveBeenCalledWith('', 'neburyx-assistant-inv-1');
    expect(page.focus).toHaveBeenCalledTimes(1);
  });

  it('closes the empty window that a name nobody here can reach opens, and opens nothing else: the page it cannot reach is open', () => {
    const empty = fakeWindow('about:blank');
    const open = vi.fn(() => asWindow(empty));
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => true, channelAvailable: () => true })).toBe('unreachable');
    expect(empty.close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('says it was refused when the browser refuses the lookup and then the window', () => {
    const open = vi.fn(() => null);
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => true, channelAvailable: () => true })).toBe('refused');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('keeps one window for each investigation', () => {
    const [one, two] = [fakeWindow(), fakeWindow('/assistant/inv-2')];
    const open = vi.fn().mockReturnValueOnce(asWindow(one)).mockReturnValueOnce(asWindow(two));
    popOut('inv-1', { open, pageOpenElsewhere: () => false, channelAvailable: () => true });
    popOut('inv-2', { open, pageOpenElsewhere: () => false, channelAvailable: () => true });
    expect(popOut('inv-1', { open, pageOpenElsewhere: () => true, channelAvailable: () => true })).toBe('focused');
    expect(one.focus).toHaveBeenCalledTimes(1);
    expect(two.focus).not.toHaveBeenCalled();
  });
});
