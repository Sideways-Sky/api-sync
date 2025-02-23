import { color } from 'robo.js'
import { ServerMessagePayload } from '../types'
import { _connections, Connection } from '.'
import { syncLogger } from './logger'

export const _states: Record<string, BaseSyncState<any>> = {}

export class SyncSignal<T> {
	key?: string

	setKey(key: string) {
		this.key = key
	}

	emit(data: T | undefined, depend?: string) {
		if (!this.key) {
			syncLogger.error('Internal: No key provided for emit')
			return
		}

		const fullKey = this.key + (depend ? '|' + depend : '')

		const broadcastResult = _connections
			.filter((c) => {
				return c.watch.includes(fullKey)
			})
			.map((c) => {
				syncLogger.debug(`Broadcasting ${color.bold(fullKey)} update to:`, c.id)
				const broadcast: ServerMessagePayload<T> = { data, key: fullKey, type: 'update' }
				c.ws.send(JSON.stringify(broadcast))
			})
		syncLogger.debug(`Broadcasted ${color.bold(fullKey)} update to ${broadcastResult.length} connections.`)
	}

	advancedEmit(process: (connection: Connection, send: (data: T | undefined) => void) => void, depend?: string) {
		if (!this.key) {
			syncLogger.error('Internal: No key provided for state advanced update')
			return
		}

		const fullKey = this.key + (depend ? '|' + depend : '')
		_connections
			.filter((c) => {
				return c.watch.includes(fullKey)
			})
			.map((c) => {
				process(c, (data) => {
					syncLogger.debug(`Advanced broadcasting ${color.bold(fullKey)} update to:`, c.id)
					const broadcast: ServerMessagePayload<T> = { data, key: fullKey, type: 'update' }
					c.ws.send(JSON.stringify(broadcast))
				})
			})
	}
}

export abstract class BaseSyncState<T> extends SyncSignal<T> {
	abstract syncGet(connection: Connection, depend?: string): T | undefined

	override setKey(key: string): void {
		super.setKey(key)
		_states[key] = this
	}
}

export class SyncState<T> extends BaseSyncState<T> {
	private _state: Record<string, T>

	constructor(initialState?: Record<string, T>) {
		super()
		this._state = initialState ?? {}
	}

	syncGet(connection: Connection, depend?: string): T | undefined {
		return this._state[depend || '']
	}

	get(depend?: string): T | undefined {
		return this._state[depend || '']
	}

	set(newState: T, depend?: string, force?: boolean) {
		if (newState === this._state[depend || ''] && !force) {
			return
		}
		this._state[depend || ''] = newState
		this.emit(newState, depend)
	}

	delete(depend?: string) {
		delete this._state[depend || '']
		this.emit(undefined, depend)
	}

	update(change: (prev: T | undefined) => T | undefined | null, depend?: string) {
		const state = this.get(depend)
		const newState = change(state)
		if (newState === state) {
			return
		}
		if (newState === undefined) {
			this.delete(depend)
		} else if (newState === null) {
			this.delete(depend)
		} else {
			this.set(newState, depend)
		}
	}
}
