// TODO: adapt the path for your app's health endpoint.
// Public config comes from cypress.config.js `expose` (Cypress.env was removed in Cypress 16).
describe('api health', () => {
  it('health endpoint responds', () => {
    const healthPath = Cypress.expose('HEALTH_PATH') || '/health';
    const apiUrl = String(Cypress.expose('API_URL') || Cypress.config('baseUrl') || '').replace(
      /\/$/,
      '',
    );
    const requestPath = String(healthPath).startsWith('/') ? String(healthPath) : `/${healthPath}`;
    cy.request(`${apiUrl}${requestPath}`).its('status').should('eq', 200);
  });
});
