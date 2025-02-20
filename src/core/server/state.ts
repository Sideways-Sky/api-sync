import { color } from 'robo.js'
import { ServerMessagePayload } from '../types'
import { syncLogger } from './logger'
import { _connections } from './'

export const _states: Record<string, SyncState<any>> = {}

export class SyncSignal<T> {
	key?: string

	setKey(key: string) {
		this.key = key
	}

	emit(data: T | undefined, depend?: string, onlyForConnectionID?: string) {
		const key = this.key
		if (!key) {
			console.error('No key provided for state update')
			return
		}

		const fullKey = key + (depend ? '|' + depend : '')

		const broadcastResult = _connections
			.filter((c) => {
				if (onlyForConnectionID && c.id !== onlyForConnectionID) {
					return false
				}
				return c.watch.includes(fullKey)
			})
			.map((c) => {
				syncLogger.debug(`Broadcasting ${color.bold(fullKey)} update to:`, c.id)
				const broadcast: ServerMessagePayload<T> = { data, key: fullKey, type: 'update' }
				c.ws.send(JSON.stringify(broadcast))
			})
		syncLogger.debug(`Broadcasted ${color.bold(fullKey)} update to ${broadcastResult.length} connections.`)
	}
}

export class SyncState<T> extends SyncSignal<T> {
	private _state: Record<string, T>

	constructor(initialState?: Record<string, T>) {
		super()
		this._state = initialState ?? {}
	}

	get(depend?: string): T | undefined {
		return this._state[depend || '']
	}

	set(newState: T | undefined, depend?: string, force?: boolean) {
		if (newState === this._state[depend || ''] && !force) {
			return
		}
		if (newState === undefined) {
			delete this._state[depend || '']
		} else {
			this._state[depend || ''] = newState
		}

		this.emit(newState, depend)
	}

	update(change: (prev: T | undefined) => T | undefined, depend?: string) {
		this.set(change(this.get(depend)), depend)
	}
}
