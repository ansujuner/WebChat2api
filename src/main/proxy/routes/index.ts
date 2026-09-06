/**
 * Proxy Service Module - Route Index
 * Export all routes
 */

import chatRouter from './chat'
import modelsRouter from './models'
import completionsRouter from './completions'
import messagesRouter from './messages'
import imagesRouter from './images'

export {
  chatRouter,
  modelsRouter,
  completionsRouter,
  messagesRouter,
  imagesRouter,
}

export default [
  chatRouter,
  modelsRouter,
  completionsRouter,
  messagesRouter,
  imagesRouter,
]
