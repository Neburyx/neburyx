import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_TIME_TEXT } from '../saved/saved-copy.js';
import { ReasonSentences } from './state-views.js';

describe('the reason of a saved pattern that lost the time of its order', () => {
  it('is said in words at the step, and another bad definition keeps its own sentence', () => {
    render(<ReasonSentences reasons={[{ code: 'bad-definition', path: ['steps', 1, 'after'] }, { code: 'bad-definition', path: ['steps', 0] }]} />);
    expect(screen.getByText(`${UNAVAILABLE_TIME_TEXT} (step 2)`)).toBeTruthy();
    expect(screen.getByText('This pattern is no longer one the product accepts. (step 1)')).toBeTruthy();
  });
});
