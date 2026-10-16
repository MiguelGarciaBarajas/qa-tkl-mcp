# Technology Usage Reference

The approved Technology Usage Facet is available in the repository root as
`Technology Usage Facet_4c446f1f37bb4a2ba900cd08ada3cefc-100926-1255-24403.pdf`.
This summary records the implications for the TKL API, MCP, and security workstream.
The PDF remains the authoritative source when its classifications change.

## Application API and MCP

- MCP is an approved AI and agentic technology for this solution.
- OpenAPI/Swagger, REST, HTTPS, and GraphQL are approved integration technologies.
- Plain HTTP without TLS is prohibited for deployed traffic.
- The gateway must remain a bounded MCP interface; it must not become generic SQL,
  shell, filesystem, or arbitrary-URL access.

## Identity and secrets

- Use an approved identity platform such as Entra ID for deployed authentication and
  authorization.
- Home-grown authentication and IdentityServer-based authentication are prohibited.
- Use an approved secrets manager such as Azure Key Vault, AWS Secrets Manager, GCP
  Secret Manager, or on-premises HashiCorp Vault.
- Secrets in source control and clear-text secrets are prohibited.
- `TKL_AUTH_TOKENS` is only a local development resolver. It must not be used as the
  production identity or secrets solution.

## Implementation language and runtime

- TypeScript is the preferred approved language for new implementation in this
  workstream.
- The current JavaScript scaffold is an interim implementation. Before production
  integration, migrate the API, gateway, contracts, and policy packages to TypeScript
  or obtain the required Architecture review for continuing with JavaScript/Node.js.

## Review rule

If a required technology is not listed in the Technology Usage Facet, consult Global
Architecture before committing to it. A technology classified as Emerging or Restricted
requires the review and approval specified by the Facet's matrix.
