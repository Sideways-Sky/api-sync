export interface ClientMessagePayload<T = unknown> {
	// From client to server
	data?: T
	key?: string
	type: 'off' | 'on' | 'pong' | 'function-call'
}
export interface ServerMessagePayload<T = unknown> {
	// From server to client
	data?: T
	key?: string
	type: 'ping' | 'update' | 'function-response'
}
export interface FunctionResponse {
	result?: unknown
	status: number
	error?: string
}
export interface FunctionCall {
	path: string
	params: any[]
}
