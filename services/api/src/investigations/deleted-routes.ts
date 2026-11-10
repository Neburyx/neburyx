/** Every route that takes an investigation ID, with whether a deleted investigation is reachable through it. Adding a route with an investigation ID to the API means adding it here and proving it in the integration test; the architecture test fails until it is. */
export const DELETED_INVESTIGATION_ROUTES: Readonly<Record<string, 'unreachable' | 'restores'>> = {
  'GET /v1/investigations/:id': 'unreachable',
  'PUT /v1/investigations/:id': 'unreachable',
  'DELETE /v1/investigations/:id': 'unreachable',
  'PUT /v1/investigations/:id/draft': 'unreachable',
  'POST /v1/investigations/:id/status': 'unreachable',
  'POST /v1/investigations/:id/restore': 'restores',
  'GET /v1/investigations/:id/views': 'unreachable',
  'POST /v1/investigations/:id/views': 'unreachable',
  'PUT /v1/investigations/:id/views/:viewId': 'unreachable',
  'POST /v1/investigations/:id/views/:viewId/restore': 'unreachable',
  'POST /v1/investigations/:id/views/:viewId/delete': 'unreachable',
};
