import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ClientMessagePayload, FunctionCall, FunctionResponse, ServerMessagePayload } from './types'
import type { BaseSyncState, SyncSignal } from './server/state'
import { Api } from './server'
import { nanoid } from 'nanoid'

interface ClientContext<API extends Api> {
	connected: boolean
	ws: WebSocket | null
	ClientProxy?: Client<API>
}

type debugEntry = 'receive' | 'callbacks' | 'connection' | 'function-call'
type debugType = debugEntry | boolean

function debugCheck(debugType: debugEntry, debug?: debugType) {
	if (typeof debug === 'boolean' || !debug) {
		return debug
	}
	return debug === debugType
}

export function createApiClient<API extends Api>(path: string = 'api-sync', debug?: debugType) {
	const Context = createContext<ClientContext<any>>({
		connected: false,
		ws: null as WebSocket | null
	})

	function ApiContextProvider(props: { children: React.ReactNode; loadingScreen?: React.ReactNode }) {
		const { children, loadingScreen = null } = props
		const context = setupSyncState<API>(path, debug)

		if (loadingScreen && (!context.connected || !context.ws)) {
			return <>{loadingScreen}</>
		}

		//@ts-ignore
		return <Context.Provider value={context}>{children}</Context.Provider>
	}

	function useApi() {
		const { ClientProxy } = useContext(Context)
		if (!ClientProxy) {
			throw new Error('useApi: Context is not defined! Use under ApiContextProvider')
		}
		return ClientProxy as Client<API>
	}

	return { useApi, ApiContextProvider }
}

type CallbackEntry = { key: string; callback: UpdateCallback }
type UpdateCallback = { func: (data: unknown, key: string) => void; cached: boolean }

let IdCounter = 0

export type Client<T extends Api> = ClientApi<Omit<T, 'internal'>>

type ClientSyncSignal<X> = {
	key: string
	sub: (callback: (data: X) => void, depend?: string) => () => void
}

type ClientSyncState<X> = {
	useSync: (depend?: string) => X | undefined
	cache: {
		get: (depend?: string) => X | undefined
		set: (value: X, depend?: string) => void
	}
} & ClientSyncSignal<X>

type ClientApi<T extends Api> = {
	// For each key in the input type `T`, `K`, determine the type of the corresponding value
	[K in keyof T]-?: T[K] extends (this: any, ...args: infer P) => any
		? // If the value is a function,
			ReturnType<T[K]> extends Promise<any>
			? // If the return type of the function is already a Promise, leave it as-is
				(...args: P) => ReturnType<T[K]>
			: // Otherwise, convert the function to return a Promise
				(...args: P) => Promise<ReturnType<T[K]>>
		: // If the value is a SyncState, return a function that returns the state
			T[K] extends SyncSignal<infer X>
			? T[K] extends BaseSyncState<infer X>
				? {
						$$: ClientSyncState<X>
					}
				: {
						$: ClientSyncSignal<X>
					}
			: // If the value is an object, recursively convert it to a Client
				T[K] extends object
				? // @ts-ignore // Ts doesn't like the recursive type
					Client<T[K]>
				: never // otherwise, return never
}

const queue: { [key: string]: (value: unknown) => void } = {}

function setupSyncState<API extends Api>(path: string = 'api-sync', debug?: debugType): ClientContext<API> {
	const [ws, setWs] = useState<WebSocket | null>(null)
	const [connected, setConnected] = useState(false)
	const cache = useRef<Record<string, unknown>>({}).current
	const callbacks = useRef<Record<string, UpdateCallback[]>>({}).current
	const callbackMap = useRef<Record<string, CallbackEntry>>({}).current
	const isRunning = useRef(false)

	useEffect(() => {
		if (isRunning.current) {
			return
		}

		isRunning.current = true
		const wsProtocol = location.protocol === 'http:' ? 'ws' : 'wss'
		const websocket = new WebSocket(`${wsProtocol}://${location.host}/${path}`)

		websocket.onopen = () => {
			debugCheck('connection', debug) && console.log('Connection established at', new Date().toISOString())
			setConnected(true)
		}

		websocket.onclose = () => {
			debugCheck('connection', debug) && console.log('Connection closed at', new Date().toISOString())
			setConnected(false)
		}

		websocket.onerror = (error) => {
			console.error('Websocket error:', error)
		}

		websocket.onmessage = (event) => {
			// Only handle parsable messages
			if (typeof event.data !== 'string') {
				return
			}

			const payload = JSON.parse(event.data) as ServerMessagePayload
			let response: ClientMessagePayload | null = null

			debugCheck('receive', debug) && console.log(`Received ${payload.type}: ${payload.key ?? ''}`, payload.data)

			switch (payload.type) {
				case 'ping':
					response = { data: undefined, type: 'pong' }
					break
				case 'update': {
					const { key, data } = payload

					// Ignore if data is undefined
					if (!key) {
						break
					}

					let cached = false

					// Broadcast the update to all callbacks
					if (callbacks[key]) {
						callbacks[key].forEach((callback) => {
							try {
								callback.func(data, key)
							} catch (error) {
								console.error('Callback error:', error)
							}
							if (callback.cached) {
								cached = true
							}
						})
					}

					if (cached) {
						// Cache the data
						cache[key] = data
					}
					break
				}
				case 'function-response': {
					if (!payload.key) {
						console.error('Payload key is missing in function-response!')
						break
					}
					const { result, status, error } = payload.data as FunctionResponse

					if (status > 200) {
						throw new Error(`ServerError: ${error}`)
					}

					queue[payload.key]?.(result)

					delete queue[payload.key]
				}
			}

			if (response) {
				websocket.send(JSON.stringify(response))
			}
		}

		setWs(websocket)
	}, [])

	const registerCallback = (key: string, callback: UpdateCallback) => {
		const callbackId = '' + IdCounter++

		// Add the callback to indices
		if (!callbacks[key]) {
			callbacks[key] = []
		}

		callbacks[key].push(callback)
		callbackMap[callbackId] = {
			key,
			callback
		}

		// Listen for updates to the key if first callback
		if (callbacks[key].length === 1) {
			ws?.send(JSON.stringify({ key, type: 'on' } as ClientMessagePayload))
		} else if (callback.cached) {
			// Apply last known state to the new callback
			callback.func(cache[key], key)
		}

		return callbackId
	}

	const unregisterCallback = (callbackId: string) => {
		const callback = callbackMap[callbackId]
		const index = callbacks[callback.key].findIndex((cb) => cb === callback.callback)

		// Remove the callback from indices
		if (index > -1) {
			callbacks[callback.key].splice(index, 1)
		}
		delete callbackMap[callbackId]

		// Stop listening for updates to the key if last callback
		if (callbacks[callback.key].length === 0) {
			ws?.send(JSON.stringify({ key: callback.key, type: 'off' } as ClientMessagePayload))
		}
	}

	function ClientProxy(path: string): unknown {
		return new Proxy(() => {}, {
			get: function (_, prop) {
				if (String(prop) === '$') {
					return {
						key: path,
						sub: (callback: (data: unknown) => void, depend?: string) => {
							const key = path + (depend ? '|' + depend : '')
							debugCheck('callbacks', debug) && console.log('add callback (sub): ', key)
							const callbackId = registerCallback(key, {
								func: (data, key) => {
									if (key === key) {
										callback(data)
									}
								},
								cached: false
							})

							return () => {
								debugCheck('callbacks', debug) && console.log('remove callback (sub): ', key)
								unregisterCallback(callbackId)
							}
						}
					}
				} else if (String(prop) === '$$') {
					return {
						key: path,
						useSync: (depend?: string) => {
							const key = path + (depend ? '|' + depend : '')
							const [state, setState] = useState<unknown>()
							const hasWs = !!ws

							useEffect(() => {
								if (connected && hasWs) {
									// Register the callback to update the state
									debugCheck('callbacks', debug) && console.log('add callback (useSync): ', key)
									const callbackId = registerCallback(key, {
										func: (data, key) => {
											if (key === key) {
												setState(data)
											}
										},
										cached: true
									})

									// Unregister the callback when the component unmounts
									return () => {
										debugCheck('callbacks', debug) && console.log('remove callback (useSync): ', key)
										unregisterCallback(callbackId)
									}
								}
							}, [connected, hasWs])

							return state
						},
						sub: (callback: (data: unknown) => void, depend?: string) => {
							const key = path + (depend ? '|' + depend : '')
							debugCheck('callbacks', debug) && console.log('add callback (sub): ', key)
							const callbackId = registerCallback(key, {
								func: (data, key) => {
									if (key === key) {
										callback(data)
									}
								},
								cached: false
							})

							return () => {
								debugCheck('callbacks', debug) && console.log('remove callback (sub): ', key)
								unregisterCallback(callbackId)
							}
						},
						cache: {
							get: (depend?: string) => {
								const key = path + (depend ? '|' + depend : '')
								return cache[key]
							},
							set: (data: unknown, depend?: string) => {
								const key = path + (depend ? '|' + depend : '')
								// Broadcast the update to all callbacks
								if (callbacks[key]) {
									callbacks[key].forEach((callback) => {
										try {
											callback.func(data, key)
										} catch (error) {
											console.error('Callback error:', error)
										}
									})
								}

								// Cache the data
								cache[key] = data
							}
						}
					}
				}
				return ClientProxy(`${path ? `${path}.` : ''}${String(prop)}`)
			},
			apply: function (_, __, argumentsList) {
				debugCheck('function-call', debug) && console.info(`Called: ${path} with parameters: ${argumentsList}`)

				// Send the function call to the server
				const key = `${nanoid()}-${path}`

				ws?.send(
					JSON.stringify({
						type: 'function-call',
						key,
						data: {
							path,
							params: argumentsList
						}
					} satisfies ClientMessagePayload<FunctionCall>)
				)

				return new Promise((resolve) => {
					queue[key] = resolve
				})
			}
		})
	}

	return {
		connected,
		ws,
		ClientProxy: ClientProxy('') as Client<API>
	}
}
