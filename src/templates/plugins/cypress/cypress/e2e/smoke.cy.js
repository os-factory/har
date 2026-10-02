// TODO: adapt routes and selectors for your app.
describe('smoke', () => {
  it('homepage loads', () => {
    cy.visit('/');
    cy.get('body').should('be.visible');
  });
});
