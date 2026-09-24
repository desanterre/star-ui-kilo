# Security policy

Please report vulnerabilities privately through GitHub: **Security › Report a vulnerability** on
<https://github.com/desanterre/star-ui-kilo>. Do not open a public issue.

Scope worth knowing about:

- `plugin/star-ui-kilo.js` runs inside Kilo and can send prompts through Kilo's client.
- `src/bridge.ts` is a local HTTP endpoint (127.0.0.1, random port, bearer token).
