// TODO: adapt the path for your app's health endpoint.
describe('api health', () => {
  it('health endpoint responds', () => {
    const healthPath = Cypress.env('HEALTH_PATH') || '/health';
    const apiUrl = String(Cypress.env('API_URL') || Cypress.config('baseUrl') || '').replace(
      /\/$/,
      '',
    );
    const requestPath = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
    cy.request(`${apiUrl}${requestPath}`).its('status').should('eq', 200);
  });
});
