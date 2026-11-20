/**
 * Authenticated media components for cross-origin / thin-desktop clients:
 * - `<AuthedImage>` loads protected `/v1/*` images via Bearer `fetch` -> managed `blob:` URL (no token in URL).
 * - `<AuthedPdfFrame>` obtains a 30s single-path resource ticket (`POST /v1/auth/resource-ticket`) for `<iframe>`.
 * - `openAuthedLink()` obtains a 30s single-path resource ticket and opens/downloads in a new tab.
 */
import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { signedResourceUrl, useAuthedBlobUrl } from './connection'

export function AuthedImage({
  src,
  onError,
  ...rest
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string; onError?: () => void }) {
  const { url, error } = useAuthedBlobUrl(src)
  useEffect(() => {
    if (error) onError?.()
  }, [error])
  if (!url) return <span className={rest.className} aria-hidden />
  return <img {...rest} src={url} onError={onError ? () => onError() : undefined} />
}

export function AuthedPdfFrame({ path, title, className }: { path: string; title: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void signedResourceUrl(path).then(u => { if (active) setUrl(u) }).catch(() => {})
    return () => { active = false }
  }, [path])
  if (!url) return null
  return <iframe src={url} title={title} className={className} />
}

export async function openAuthedLink(path: string, opts: { download?: boolean } = {}): Promise<void> {
  const url = await signedResourceUrl(path, opts)
  window.open(url, '_blank', 'noopener,noreferrer')
}
