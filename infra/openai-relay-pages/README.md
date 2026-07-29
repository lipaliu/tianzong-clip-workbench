# TianClip OpenAI relay

This Cloudflare Pages Function is the narrow HTTPS egress used when the
Tencent worker cannot reach `api.openai.com` directly.

It:

- requires `OAI-Sites-Authorization: Bearer <RELAY_AUTH_TOKEN>`;
- only forwards `/v1/models`, `/v1/responses`, and
  `/v1/audio/transcriptions`;
- forwards the caller's OpenAI authorization header without storing an
  OpenAI key in the relay;
- disables caching and strips response cookies.

Production URL:

`https://tianclip-openai-relay.pages.dev/v1`

The processor must use the same value for `OPENAI_SITES_BYPASS_TOKEN` that is
stored as the Pages secret `RELAY_AUTH_TOKEN`.

Deploy from this directory:

```sh
npx wrangler pages deploy public \
  --project-name tianclip-openai-relay \
  --branch main \
  --commit-dirty=true
```
