# Security Policy

## Supported Versions

Security fixes are applied to actively maintained release lines:

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

The `main` branch receives fixes for the latest development release until a new version is tagged.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

### Preferred: GitHub Private Security Advisory

Report vulnerabilities through GitHub's private advisory workflow:

[https://github.com/os-factory/har/security/advisories/new](https://github.com/os-factory/har/security/advisories/new)

This keeps details confidential until a fix is available.

### Alternative: Contact maintainers

If you cannot use GitHub Advisories, contact the [repository maintainers](https://github.com/os-factory/har) privately (do not disclose the vulnerability in a public issue).

## Response Timeline

| Stage | Target |
| ----- | ------ |
| Acknowledgment | Within 2 business days |
| Initial triage and severity assessment | Within 7 calendar days |
| Fix or mitigation plan | Depends on severity; critical issues prioritized |
| Coordinated disclosure | After a patch is released (or agreed timeline) |

We will keep you informed of progress and credit reporters in the advisory when appropriate, unless you prefer to remain anonymous.

## Scope

This policy covers the `@har/cli` package, the HAR MCP server, and the Mission Control dashboard in this repository. Vulnerabilities in third-party dependencies should be reported to the upstream project; we still welcome reports if you believe HAR's usage materially affects exploitability.
