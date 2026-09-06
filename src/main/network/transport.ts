import axios, { AxiosError, AxiosHeaders, CanceledError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { net, type ClientRequest, type Session } from 'electron'
import { PassThrough, Transform, type Readable } from 'node:stream'
import { getNetworkSession } from './proxy'

// Chromium owns framing, compression, socket reuse and TLS. Forwarding these
// Node framing headers is either forbidden or would describe different bytes.
const TRANSPORT_HEADERS = new Set(['content-length', 'host', 'trailer', 'te', 'upgrade', 'cookie2', 'keep-alive', 'transfer-encoding', 'connection', 'accept-encoding'])

function networkError(error: unknown, config: InternalAxiosRequestConfig, request?: ClientRequest): AxiosError {
  if (axios.isAxiosError(error)) return error
  const code = error instanceof Error ? error.message.match(/\bERR_[A-Z_]+\b/)?.[0] : undefined
  // Do not propagate arbitrary native errors containing URLs/query credentials.
  return new AxiosError(`Network request failed${code ? ` (${code})` : ''}. Check the selected network proxy and connection.`, code || AxiosError.ERR_NETWORK, config, request)
}

function limitBytes(maximum: number | undefined, error: () => Error, onProgress?: () => void): Transform {
  let count = 0
  return new Transform({
    transform(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      count += bytes.byteLength
      onProgress?.()
      if (maximum !== undefined && maximum >= 0 && count > maximum) callback(error())
      else callback(null, bytes)
    },
  })
}

/** Dependency injection keeps regression tests entirely local and credential-free. */
export function createChromiumAxiosAdapter(
  selectSession: () => Promise<Session> = getNetworkSession,
  makeRequest: typeof net.request = options => net.request(options),
): AxiosAdapter {
  return async config => {
    const url = new URL(axios.getUri(config))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new AxiosError('Only HTTP(S) URLs without embedded credentials are supported', AxiosError.ERR_BAD_REQUEST, config)
    }
    if (config.proxy || config.httpAgent || config.httpsAgent || config.socketPath || config.transport) {
      throw new AxiosError('Per-request Node proxy/agent overrides are not supported; use the application network proxy setting', AxiosError.ERR_BAD_OPTION, config)
    }
    const selectedSession = await selectSession()
    config.cancelToken?.throwIfRequested()
    if (config.signal?.aborted) throw new CanceledError('Request canceled')

    let data = config.data
    const headers = new AxiosHeaders(config.headers)
    if (data && typeof data.getHeaders === 'function') headers.set(data.getHeaders())
    if (config.auth) headers.set('Authorization', `Basic ${Buffer.from(`${config.auth.username || ''}:${config.auth.password || ''}`).toString('base64')}`)
    if (data instanceof ArrayBuffer) data = Buffer.from(data)
    else if (ArrayBuffer.isView(data)) data = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (data !== undefined && data !== null && typeof data !== 'string' && !Buffer.isBuffer(data) && typeof data.pipe !== 'function') {
      throw new AxiosError('Unsupported request body type', AxiosError.ERR_BAD_REQUEST, config)
    }
    if ((typeof data === 'string' || Buffer.isBuffer(data)) && config.maxBodyLength !== undefined && config.maxBodyLength >= 0 && Buffer.byteLength(data) > config.maxBodyLength) {
      throw new AxiosError('Request body exceeds maxBodyLength', AxiosError.ERR_BAD_REQUEST, config)
    }

    const cancelToken = config.cancelToken as typeof config.cancelToken & { subscribe?: (listener: () => void) => void; unsubscribe?: (listener: () => void) => void }
    return new Promise<AxiosResponse>((resolve, reject) => {
      let request: ClientRequest | undefined
      let output: PassThrough | undefined
      let upload: Transform | undefined
      let download: Transform | undefined
      let incomingSource: Readable | undefined
      let settled = false
      let complete = false
      let receivedEnd = false
      let failed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        config.signal?.removeEventListener?.('abort', cancel)
        cancelToken?.unsubscribe?.(cancel)
      }
      const fail = (error: unknown) => {
        if (complete || failed) return
        failed = true
        cleanup()
        const normalized = networkError(error, config, request)
        if (!settled) { settled = true; reject(normalized) }
        output?.destroy(normalized)
        incomingSource?.unpipe()
        download?.destroy()
        if (data && typeof data.unpipe === 'function' && upload) data.unpipe(upload)
        upload?.destroy()
        request?.abort()
      }
      const cancel = () => fail(new CanceledError('Request canceled'))
      const armTimeout = () => {
        if (timer) clearTimeout(timer)
        if (config.timeout && config.timeout > 0 && !failed && !receivedEnd) {
          timer = setTimeout(() => fail(new AxiosError(`Network request timed out after ${config.timeout} ms without network progress`, AxiosError.ECONNABORTED, config, request)), config.timeout)
        }
      }
      try {
        request = makeRequest({
          method: (config.method || 'get').toUpperCase(), url: url.href,
          session: selectedSession, useSessionCookies: false,
          // Do not use any credentials/cookies cached by another account.
          // Explicit Authorization/Cookie headers below remain per-request.
          credentials: 'omit', redirect: 'manual', cache: 'no-store',
        })
        for (const [name, value] of Object.entries(headers.toJSON())) {
          if (!TRANSPORT_HEADERS.has(name.toLowerCase()) && value !== null && value !== undefined && value !== false) {
            request.setHeader(name, Array.isArray(value) ? value.join(', ') : String(value))
          }
        }
        let redirects = 0
        request.on('redirect', (_status, _method, destination) => {
          let target: URL
          try { target = new URL(destination) }
          catch { fail(new AxiosError('Invalid network redirect URL', AxiosError.ERR_BAD_RESPONSE, config, request)); return }
          // Never leak provider-specific token/Cookie headers to another origin.
          // Chromium cannot change request headers after the first write.
          if (target.origin !== url.origin || ++redirects > (config.maxRedirects ?? 5)) {
            fail(new AxiosError('Redirect blocked: cross-origin or redirect limit exceeded', AxiosError.ERR_FR_TOO_MANY_REDIRECTS, config, request))
          } else request!.followRedirect()
        })
        request.on('login', (_authInfo, callback) => {
          callback()
          fail(new AxiosError('Network proxy authentication is required; configure it in the system proxy settings', AxiosError.ERR_BAD_RESPONSE, config, request))
        })
        request.on('error', fail)
        request.on('abort', () => { if (!failed && !complete) cancel() })
        // Electron 44 emits Writable `close` after upload finish, before the
        // response exists. Only response close/aborted/error signal truncation.
        request.on('response', incoming => {
          if (failed) return
          incomingSource = incoming as unknown as Readable
          armTimeout()
          output = new PassThrough()
          // The promise consumer receives this stream on the next microtask.
          // Keep immediate native failures from becoming unhandled exceptions.
          output.on('error', () => {})
          const responseHeaders = AxiosHeaders.from(incoming.headers as Record<string, any>)
          // Electron delivers decompressed response bytes.
          responseHeaders.delete('content-encoding')
          const response: AxiosResponse = {
            data: output, status: incoming.statusCode, statusText: incoming.statusMessage,
            headers: responseHeaders, config, request,
          }
          incoming.on('error', fail)
          incoming.on('aborted', () => fail(new AxiosError('Network response aborted', AxiosError.ERR_NETWORK, config, request)))
          incoming.on('end', () => { receivedEnd = true; cleanup() })
          incomingSource.on('close', () => { if (!receivedEnd && !failed) fail(new AxiosError('Network response ended prematurely', AxiosError.ERR_NETWORK, config, request)) })
          output.once('end', () => { complete = true; cleanup() })
          output.once('close', () => { if (!receivedEnd && !complete && !failed) cancel() })
          const limiter = download = limitBytes(config.maxContentLength, () => new AxiosError('Response exceeds maxContentLength', AxiosError.ERR_BAD_RESPONSE, config, request), armTimeout)
          limiter.on('error', fail)
          const finish = (body: any) => {
            const result = { ...response, data: body }
            if (settled || failed) return
            settled = true
            if (!config.validateStatus || config.validateStatus(result.status)) resolve(result)
            else reject(new AxiosError(`Request failed with status code ${result.status}`, result.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, request, result))
          }
          if (config.responseType === 'stream') {
            finish(output)
          } else {
            const chunks: Buffer[] = []
            output.on('data', chunk => chunks.push(Buffer.from(chunk)))
            output.once('end', () => {
              const body = Buffer.concat(chunks)
              if (config.responseType === 'arraybuffer') finish(body)
              else {
                try { finish(body.toString((config.responseEncoding || 'utf8') as BufferEncoding).replace(/^\uFEFF/, '')) }
                catch (error) { settled = true; reject(networkError(error, config, request)) }
              }
            })
          }
          // IncomingMessage is a Node readable; piping preserves backpressure.
          ;(incoming as unknown as Readable).pipe(limiter).pipe(output)
        })
        config.signal?.addEventListener?.('abort', cancel, { once: true })
        if (cancelToken?.subscribe) cancelToken.subscribe(cancel)
        else cancelToken?.promise.then(cancel)
        armTimeout()
        if (data && typeof data.pipe === 'function') {
          upload = limitBytes(config.maxBodyLength, () => new AxiosError('Request body exceeds maxBodyLength', AxiosError.ERR_BAD_REQUEST, config, request), armTimeout)
          data.on('error', fail)
          upload.on('error', fail)
          request.chunkedEncoding = true
          data.pipe(upload).pipe(request)
        } else request.end(data ?? undefined)
      } catch (error) { fail(error) }
    })
  }
}

export const chromiumAxiosAdapter = createChromiumAxiosAdapter()
