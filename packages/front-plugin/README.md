# @overturn-ai/front-plugin

Overturn capture adapter for [Front](https://front.com) using the Front Plugin SDK.

Records what the AI drafted, what the teammate sent, and a one-line reason (`POST /v1/capture` with `source: "front"` and `externalId: "fr:<conversation id>"`) without ever blocking a send on capture failure.

## Scripts

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

`build` outputs the self-contained bundle to `dist/app/` and packages `dist/overturn-front-plugin.zip`.
