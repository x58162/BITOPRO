# BITOPRO Security Modules

This folder separates security concerns from the trading strategy.

## Modules

- `authenticator.js`: RFC 6238-compatible TOTP secret/code generation and otpauth URI creation. The QR image can be rendered from the URI by the UI layer.
- `encryption.js`: AES-256-GCM helpers for encrypting secrets at rest. Requires a per-installation `BITOPRO_MASTER_KEY` (Base64-encoded 32-byte key).
- `session.js`: per-session in-memory session store interface.
- `trade-guard.js`: per-session 10-minute trade-unlock state.
- `index.js`: module exports.

## Important implementation status

These are isolated building blocks only. They are **not yet connected to the Express routes or browser UI**. Until the full authentication flow is integrated, the existing dashboard behavior remains unchanged.

Before enabling these modules in production, implement and test:

1. First-run setup ownership / one-time setup token.
2. Persistent, per-installation storage for TOTP secret and encrypted exchange credentials.
3. Secure HttpOnly, Secure, SameSite cookies and session rotation.
4. CSRF protection, login/unlock rate limiting, and recovery/reset flow.
5. Server-side checks on every order create/edit/cancel and strategy-control endpoint.
6. Persistent per-session authorization with expiry and logout/revocation.
7. HTTPS for any non-localhost deployment.

Never commit `.env`, master keys, TOTP secrets, QR provisioning URLs, session IDs, or exchange API credentials.

The modules use Node.js built-ins and do not modify the trading strategy.
