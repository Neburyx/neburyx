import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from './api/client.js';
import { fakeClient } from './api/fake-client.js';
import { Principal } from './principal.js';

describe('the principal, when the server answers with an error', () => {
  it('shows the error code and the trace ID', async () => {
    const client: ApiClient = fakeClient({
      getMe: async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'The source is unavailable.', retryable: true, traceId: 'trace-77' } }),
    });
    render(<Principal client={client} />);
    expect((await screen.findByRole('alert')).textContent).toBe('SOURCE_UNAVAILABLE · trace trace-77');
  });
});
