import { color } from 'robo.js'
import { ServerMessagePayload } from '../types'
import { syncLogger } from './logger'
import { _connections } from './'

export const _states: Record<string, SyncState<any>> = {}

export class SyncState<T> {
	key?: string
	private _state: Record<string, T>

	constructor(initialState?: Record<string, T>) {
		this._state = initialState ?? {}
	}

	setKey(key: string) {
		this.key = key
		_states[key] = this
	}

	get(depend?: string): T | undefined {
		return this._state[depend || '']
	}

	set(newState: T | undefined, depend?: string, force?: boolean) {
		if (newState === this._state && !force) {
			return
		}
		if (newState === undefined) {
			delete this._state[depend || '']
		} else {
			this._state[depend || ''] = newState
		}
		const key = this.key
		if (!key) {
			console.error('No key provided for state update')
			return
		}

		const fullKey = key + (depend ? '|' + depend : '')

		const broadcastResult = _connections
			.filter((c) => c.watch.includes(fullKey))
			.map((c) => {
				syncLogger.debug(`Broadcasting ${color.bold(fullKey)} state update to:`, c.id)
				const broadcast: ServerMessagePayload<T> = { data: newState, key: fullKey, type: 'update' }
				c.ws.send(JSON.stringify(broadcast))
			})
		syncLogger.debug(`Broadcasted ${color.bold(fullKey)} state update to ${broadcastResult.length} connections.`)
	}

	update(change: (prev: T | undefined) => T | undefined, depend?: string) {
		this.set(change(this.get(depend)), depend)
	}
}
