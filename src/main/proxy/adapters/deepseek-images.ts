import { randomUUID } from 'node:crypto'

// Deliberately below the website's dynamic upload limits. This is a local API
// resource bound, not a claim that every account has the same website quota.
export const DEEPSEEK_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const DEEPSEEK_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
export const DEEPSEEK_MAX_IMAGES = 10

export interface DeepSeekImage {
  readonly bytes: Buffer
  readonly mime: string
  readonly extension: string
}

const formats = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const

function matchesImageSignature(bytes: Buffer, mime: keyof typeof formats): boolean {
  if (bytes.length < 16) return false
  switch (mime) {
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString('ascii', 12, 16) === 'IHDR'
    case 'image/jpeg': return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    case 'image/webp': return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  }
}

export function decodeDeepSeekImage(url: unknown): DeepSeekImage {
  if (typeof url !== 'string') throw new Error('DeepSeek image_url.url must be a base64 image data URL')
  // Never fetch arbitrary client URLs with a provider-authenticated transport.
  // DNS pre-checks alone do not prevent rebinding, especially through a system
  // proxy. Remote images must be converted to data URLs by the API client.
  if (!url.startsWith('data:')) throw new Error('DeepSeek images require a base64 data URL; download remote images in your client first')
  if (url.length > Math.ceil(DEEPSEEK_MAX_IMAGE_BYTES / 3) * 4 + 80) {
    throw new Error('DeepSeek image exceeds the 10 MiB limit')
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url)
  if (!match) throw new Error('DeepSeek images must be base64 PNG, JPEG, WebP or GIF data URLs')
  const mime = match[1].toLowerCase() as keyof typeof formats
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length > DEEPSEEK_MAX_IMAGE_BYTES) throw new Error('DeepSeek image exceeds the 10 MiB limit')
  if (bytes.toString('base64') !== match[2] || !matchesImageSignature(bytes, mime)) {
    throw new Error('DeepSeek image data is invalid or does not match its declared MIME type')
  }
  return { bytes, mime, extension: formats[mime] }
}

/** Only this request's delta messages are considered; no account-wide cache. */
export function collectDeepSeekImages(messages: ReadonlyArray<{ role: string; content: unknown }>): DeepSeekImage[] {
  const images: DeepSeekImage[] = []
  let total = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'image_url') continue
      if (message.role !== 'user') throw new Error('DeepSeek image blocks are supported only in user messages')
      if (images.length >= DEEPSEEK_MAX_IMAGES) throw new Error('DeepSeek supports at most 10 images per request')
      const image = decodeDeepSeekImage(block.image_url?.url)
      total += image.bytes.length
      if (total > DEEPSEEK_MAX_TOTAL_IMAGE_BYTES) throw new Error('DeepSeek images exceed the 20 MiB combined limit')
      images.push(image)
    }
  }
  return images
}

export function createDeepSeekImageMultipart(image: DeepSeekImage): { body: Buffer; contentType: string } {
  const boundary = `----Chat2API${randomUUID().replace(/-/g, '')}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${image.extension}"\r\nContent-Type: ${image.mime}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, image.bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

export interface DeepSeekUploadedFile {
  readonly id: string
  readonly status: 'PENDING' | 'PARSING' | 'SUCCESS'
}

export function validateDeepSeekUploadedFile(value: unknown): DeepSeekUploadedFile {
  const file = value as Record<string, unknown> | null
  if (!file || typeof file !== 'object' || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id)) {
    throw new Error('DeepSeek image upload returned an invalid file ID')
  }
  if (file.audit_result === 'reject') throw new Error('DeepSeek image was rejected by the provider')
  if (!['PENDING', 'PARSING', 'SUCCESS'].includes(String(file.status))) {
    // Never expose file names, extracted text, signed paths, or remote errors.
    throw new Error('DeepSeek image processing failed or returned an unsupported status')
  }
  return { id: file.id, status: file.status as DeepSeekUploadedFile['status'] }
}
