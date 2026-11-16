# @overturn-ai/intercom-app

Overturn capture adapter for [Intercom](https://www.intercom.com) (Canvas Kit inbox surface).

Records what Fin/AI drafted, what the teammate sent, and a one-line reason (`POST /v1/capture` with `source: "intercom"` and `externalId: "ic:<conversation id>"`). Distinguishes AI-assisted drafts (`draft:ai`) from human-typed (`draft:manual`) or unknown (`draft:unknown`) origins without guessing.

## Scripts

```bash
pnpm --filter @overturn-ai/intercom-app test
pnpm --filter @overturn-ai/intercom-app typecheck
pnpm --filter @overturn-ai/intercom-app build
```
