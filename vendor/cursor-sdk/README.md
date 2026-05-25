# @cursor/sdk

TypeScript SDK for Cursor agents.

See the SDK TypeScript docs at https://cursor.com/docs/api/sdk/typescript.

## Latest model aliases

The SDK accepts latest-style model aliases returned by `Cursor.models.list()`:

```typescript
import { Agent, Cursor } from "@cursor/sdk";

const model = (await Cursor.models.list()).find(model =>
  model.aliases?.includes("composer-latest")
);

if (model) {
  const agent = await Agent.create({
    model: { id: "composer-latest" },
  });
}
```
