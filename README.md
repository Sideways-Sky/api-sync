<p align="center">✨ <strong>Generated with <a href="https://roboplay.dev/create-robo">create-robo</a> magic!</strong> ✨</p>

---

# 🚀 api-sync

Welcome to _api-sync_! Real-time state sync across clients and server the simplest way possible. Perfect for multiplayer games and chat apps. It's like magic, but real! 🎩✨

➞ [📚 **Documentation:** Getting started](https://docs.roboplay.dev/docs/getting-started)

➞ [🚀 **Community:** Join our Discord server](https://roboplay.dev/discord)

> 👩‍💻 **Are you the plugin developer?** Check out the **[Development Guide](DEVELOPMENT.md)** for instructions on how to develop, build, and publish this plugin.

## Installation

To add this plugin to your Robo.js project:

```bash
npx robo add api-sync
```

> **Note:** You will also need to install the `@robojs/server`.

## Usage 🎨

### server

```ts
// src/events/_start.ts
import { SyncServer } from 'api-sync/server.js'
import { syncApi, Api, SyncState } from '../syncApi'

const myApi = {
	hello: (sessionId) => {
		console.log('Hello from', sessionId)
	}
    counter: new SyncState<number>()
} satisfies Api

export type MyApi = typeof myApi

export default async () => {
	SyncServer.defineApi(syncApi)
}
```

### client

setup client api provider

```tsx
// src/app/App.tsx
import { Activity } from './Activity'
import './App.css'
import { createApiClient } from 'api-sync/client.js'
import type { MyApi } from '../events/_start.js'
const { ApiContextProvider, useApi } = createApiClient<MyApi>()
export { useApi }

export default function App() {
	return (
		<DiscordContextProvider>
			<ApiContextProvider>
				<Activity />
			</ApiContextProvider>
		</DiscordContextProvider>
	)
}
```

use api

```tsx
// src/app/Activity.tsx
import { useApi } from '.App'

export default function Activity() {
	const api = useApi()
	const counter = api.counter.$.useSync()

	useEffect(() => {
		api.hello()
	}, [])
}
```
