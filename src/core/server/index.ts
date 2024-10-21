import { syncLogger } from './logger.js'
import { Server } from '@robojs/server'
import { NodeEngine } from '@robojs/server/engines.js'
import { nanoid } from 'nanoid'
import WebSocket, { WebSocketServer } from 'ws'
import { ClientMessagePayload, FunctionCall, FunctionResponse, ServerMessagePayload } from '../types.js'
import { _states, SyncState } from './state.js'

export const SyncServer = { getSocketServer, defineApi }

interface Connection {
	id: string
	isAlive: boolean
	watch: string[]
	ws: WebSocket
}

export const _connections: Array<Connection> = []

type NestedRecord<K extends keyof any, T> = { [P in K]: T | NestedRecord<K, T> }
export type Api = NestedRecord<
	string | symbol | number,
	((this: Connection, ...args: any[]) => any) | SyncState<any>
> & {
	internal?: {
		onJoin?: (connection: Connection) => void
		onAfterLeave?: (connection: Connection) => void
		onBeforeLeave?: (connection: Connection) => void
	}
}

let _wss: WebSocketServer | undefined

// Should only be called once on the server
async function defineApi(api: Api, path: string = '/api-sync') {
	setKeys(api, '')
	await Server.ready()
	syncLogger.debug('Creating WebSocket server')
	createSocketServer(api, path)
	syncLogger.debug('WebSocket server created successfully.')
	syncLogger.ready('API Sync is live')
}

function createSocketServer(api: Api, path: string) {
	// Create WebSocket server piggybacking on the HTTP server
	_wss = new WebSocketServer({
		noServer: true
	})

	// Keep track of the connection liveness
	setInterval(() => {
		if (_connections.length === 0) {
			return
		}

		syncLogger.debug(`Pinging ${_connections.length} connections...`)
		const deadIndices: number[] = []
		_connections.forEach((conn, index) => {
			if (!conn.isAlive) {
				syncLogger.warn(`Connection ${conn.id} is dead. Terminating...`)
				api.internal?.onBeforeLeave?.(conn)

				conn.ws.terminate()
				deadIndices.push(index)
				return
			}

			conn.isAlive = false
			const ping: ServerMessagePayload = { data: undefined, type: 'ping' }
			conn.ws.send(JSON.stringify(ping))
		})

		// Remove dead connections
		deadIndices.forEach((index) => {
			const conn = _connections.splice(index, 1)[0]
			api.internal?.onAfterLeave?.(conn)
		})
	}, 30_000)

	// Handle incoming connections
	_wss.on('connection', (ws) => {
		// Register the connection
		const connection: Connection = { id: nanoid(), isAlive: true, watch: [], ws }
		_connections.push(connection)
		syncLogger.debug('New connection established! Registered as', connection.id)
		api.internal?.onJoin?.(connection)

		// Detect disconnections
		ws.on('close', () => {
			const index = _connections.findIndex((c) => c.id === connection.id)
			syncLogger.debug(`Connection ${connection.id} closed. Removing...`)
			api.internal?.onBeforeLeave?.(connection)

			if (index > -1) {
				_connections.splice(index, 1)
			}

			api.internal?.onAfterLeave?.(connection)
		})

		ws.on('message', (message) => {
			// Handle incoming messages
			const payload: ClientMessagePayload = JSON.parse(message.toString())
			const { data, key, type } = payload
			syncLogger.debug(`Received from ${connection.id}:`, payload)

			if (!type) {
				syncLogger.error('Payload type is missing!')
				return
			}

			// Ping responses are... unique
			if (type === 'pong') {
				const conn = _connections.find((c) => c.id === connection.id)

				if (conn) {
					conn.isAlive = true
				}
				return
			} else if (!key) {
				syncLogger.error('Payload key is missing!')
				return
			}

			// Handle the message based on the type
			let response: ServerMessagePayload | undefined

			switch (type) {
				case 'off': {
					// Remove the key from the watch list
					const index = connection.watch.findIndex((k) => k === key)
					if (index > -1) {
						connection.watch.splice(index, 1)
					}
					syncLogger.debug(`Connection ${connection.id} is now watching:`, connection.watch, ' removed:', index)
					break
				}
				case 'on': {
					// Add the key to the watch list
					if (!connection.watch.includes(key)) {
						connection.watch.push(key)
						syncLogger.debug(`Connection ${connection.id} is now watching:`, connection.watch, ' added:', key)
					}

					if (key.includes('|')) {
						const keyParts = key.split('|')
						const cleanKey = keyParts[0]
						const depend = keyParts[1]

						if (_states[cleanKey]?.get(depend)) {
							response = {
								data: _states[cleanKey].get(depend),
								key,
								type: 'update'
							}
						}
					}

					// Send the current state to the client (if it exists)
					if (_states[key]?.get()) {
						response = {
							data: _states[key].get(),
							key,
							type: 'update'
						}
					}
					break
				}
				case 'function-call': {
					if (!data) {
						syncLogger.error('Payload data is missing in function-call!')
						break
					}
					const { path, params } = data as FunctionCall

					syncLogger.debug('Called function with parameters: ', {
						key,
						path,
						params
					})

					const procedureSplit = path.split('.')
					let procedure = api

					for (const procedureName of procedureSplit) {
						// @ts-ignore
						procedure = procedure[procedureName]
					}

					try {
						// @ts-ignore
						const result = procedure.call(connection, ...params)
						syncLogger.debug(`result for method ${path}`, { result })

						response = {
							type: 'function-response',
							key,
							data: {
								result,
								status: 200
							}
						} satisfies ServerMessagePayload<FunctionResponse>
					} catch (error: any) {
						console.error(error)
						response = {
							type: 'function-response',
							key,
							data: {
								error: error.toString(),
								status: 200
							}
						} satisfies ServerMessagePayload<FunctionResponse>
					}
				}
			}

			if (response) {
				syncLogger.debug(`Sending to ${connection.id}:`, response)
				ws.send(JSON.stringify(response))
			}
		})
	})

	// Handle upgrade requests
	const engine = Server.get() as NodeEngine
	engine.registerWebsocket(path, (req, socket, head) => {
		const wss = getSocketServer()
		wss?.handleUpgrade(req, socket, head, function done(ws) {
			wss?.emit('connection', ws, req)
		})
	})
}

function getSocketServer() {
	return _wss
}

// Set SyncState keys based on the path
function setKeys(api: Api, path: string) {
	for (const key of Object.keys(api)) {
		const newPath = path.concat(key)
		if (api[key] instanceof SyncState) {
			api[key].setKey(newPath)
		} else if (typeof api[key] === 'object') {
			setKeys(api[key], newPath)
		}
	}
}
