import { ready } from '@robojs/server'
import { syncLogger } from '../core/server/logger'

export default async () => {
	syncLogger.info('Starting API Sync...')
	await ready()
	syncLogger.info('API Sync started!')
}
