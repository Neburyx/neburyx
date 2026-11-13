import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useMenuPlacement } from './menu-placement.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Demo({ open, scroller = false }: { readonly open: boolean; readonly scroller?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMenuPlacement(open, menu, trigger);
  return (
    <div data-scroller={scroller ? 'yes' : undefined} style={scroller ? { overflowY: 'auto' } : undefined}>
      <button ref={trigger} type="button">
        open
      </button>
      {open ? <div ref={menu} role="menu" /> : null}
    </div>
  );
}

/** A window 900 high; the button sits at `top`, 30 high; the menu is `height` high. */
function layout(top: number, height: number, scrollerBottom?: number): void {
  vi.stubGlobal('innerHeight', 900);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset['scroller'] !== undefined) return { top: 0, bottom: scrollerBottom ?? 900, height: scrollerBottom ?? 900 } as DOMRect;
    return this.tagName === 'BUTTON' ? ({ top, bottom: top + 30, height: 30 } as DOMRect) : ({ top: top + 30, bottom: top + 30 + height, height } as DOMRect);
  });
}

describe('the placement of an open menu in a window 900 high', () => {
  it('opens downward when it fits below', () => {
    layout(100, 300);
    render(<Demo open />);
    expect(screen.getByRole('menu').dataset['placement']).toBeUndefined();
    expect(screen.getByRole('menu').style.maxHeight).toBe('');
  });

  it('opens upward when it does not fit below and fits above', () => {
    layout(700, 400);
    render(<Demo open />);
    expect(screen.getByRole('menu').dataset['placement']).toBe('above');
    expect(screen.getByRole('menu').style.maxHeight).toBe('');
  });

  it('takes the side with more room and scrolls inside when it fits on neither', () => {
    layout(600, 1200);
    render(<Demo open />);
    expect(screen.getByRole('menu').dataset['placement']).toBe('above');
    expect(screen.getByRole('menu').style.maxHeight).toBe('592px');
  });

  it('keeps downward when below has more room than above for a menu that fits neither', () => {
    layout(100, 1200);
    render(<Demo open />);
    expect(screen.getByRole('menu').dataset['placement']).toBeUndefined();
    expect(screen.getByRole('menu').style.maxHeight).toBe('762px');
  });

  it('measures against the panel that clips the menu when it ends above the bottom of the window', () => {
    layout(400, 200, 500);
    render(<Demo open scroller />);
    expect(screen.getByRole('menu').dataset['placement']).toBe('above');
  });

  it('scrolls inside, below, when the panel leaves room for neither side', () => {
    layout(100, 400, 500);
    render(<Demo open scroller />);
    expect(screen.getByRole('menu').dataset['placement']).toBeUndefined();
    expect(screen.getByRole('menu').style.maxHeight).toBe('362px');
  });
});
