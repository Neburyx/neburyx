import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state.js';

describe('the empty state', () => {
  it('is a region named by its title, with the sentence and the actions it is given', () => {
    render(
      <EmptyState title="No investigations yet" sentence="Start somewhere.">
        <button type="button">Go</button>
      </EmptyState>,
    );
    const region = screen.getByRole('region', { name: 'No investigations yet' });
    expect(region.querySelector('h2')?.textContent).toBe('No investigations yet');
    expect(region.textContent).toContain('Start somewhere.');
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
  });

  it('has no actions block when it is given none', () => {
    render(<EmptyState title="No investigations yet" sentence="Start somewhere." />);
    expect(document.querySelector('.empty-state-actions')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
