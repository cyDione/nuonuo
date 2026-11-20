/**
 * QR code scanner supporting both live camera (`BarcodeDetector` with `jsqr` fallback)
 * and image file / clipboard paste decoding (convenient on desktops).
 */
import jsQR from 'jsqr'
import { Camera, ImageUp, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { tx } from './i18n'

async function decodeImageData(img: ImageData): Promise<string | null> {
  const res = jsQR(img.data, img.width, img.height)
  return res?.data ?? null
}

async function decodeFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  bitmap.close()
  return decodeImageData(data)
}

export function QrScanner({ onDetected, onClose }: { onDetected(value: string): void; onClose(): void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<'camera' | 'file'>('camera')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mode !== 'camera') return
    let stopped = false
    let stream: MediaStream | undefined
    let raf = 0

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(tx('当前环境无法调用摄像头，可改用「上传二维码图片」。'))
        setMode('file')
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        const BarcodeDet = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> } }).BarcodeDetector
        const detector = BarcodeDet ? new BarcodeDet({ formats: ['qr_code'] }) : null

        const tick = async () => {
          if (stopped || !videoRef.current) return
          const v = videoRef.current
          if (v.readyState >= 2 && v.videoWidth > 0) {
            if (detector) {
              try {
                const hits = await detector.detect(v)
                if (hits[0]?.rawValue) { onDetected(hits[0].rawValue); return }
              } catch { /* fall through to jsqr */ }
            }
            const canvas = canvasRef.current
            if (canvas) {
              canvas.width = v.videoWidth
              canvas.height = v.videoHeight
              const ctx = canvas.getContext('2d', { willReadFrequently: true })
              if (ctx) {
                ctx.drawImage(v, 0, 0)
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
                const hit = await decodeImageData(img)
                if (hit) { onDetected(hit); return }
              }
            }
          }
          raf = requestAnimationFrame(() => { void tick() })
        }
        raf = requestAnimationFrame(() => { void tick() })
      } catch {
        if (!stopped) {
          setError(tx('无法打开摄像头权限，请改用「上传二维码图片」或粘贴连接串。'))
          setMode('file')
        }
      }
    }
    void start()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [mode, onDetected])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const value = await decodeFile(file).catch(() => null)
    if (!value) { setError(tx('图片中未识别到有效二维码')); return }
    onDetected(value)
  }

  return <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div role="dialog" aria-modal="true" aria-label={tx('扫描配对二维码')} className="anim-pop w-full max-w-md overflow-hidden rounded-3xl border border-line bg-panel p-5 shadow-2xl">
      <div className="flex items-center justify-between gap-2 pb-3">
        <h2 className="text-base font-semibold">{tx('扫描配对二维码')}</h2>
        <button type="button" onClick={onClose} aria-label={tx('关闭')} className="press rounded-full p-1.5 text-muted hover:bg-sunken hover:text-fg"><X size={16} /></button>
      </div>
      <div className="mb-3 flex gap-2">
        <button type="button" onClick={() => { setError(null); setMode('camera') }}
          className={`press flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-medium ${mode === 'camera' ? 'bg-ink text-ink-fg' : 'bg-sunken text-muted hover:text-fg'}`}>
          <Camera size={14} />{tx('摄像头扫码')}
        </button>
        <button type="button" onClick={() => { setError(null); setMode('file') }}
          className={`press flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-medium ${mode === 'file' ? 'bg-ink text-ink-fg' : 'bg-sunken text-muted hover:text-fg'}`}>
          <ImageUp size={14} />{tx('上传二维码图片')}
        </button>
      </div>
      {mode === 'camera' ? (
        <div className="relative overflow-hidden rounded-2xl bg-black aspect-[4/3]">
          <video ref={videoRef} muted playsInline className="size-full object-cover" />
          <canvas ref={canvasRef} className="hidden" />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="size-44 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-sunken px-4 py-10 text-center hover:border-faint">
          <ImageUp size={24} className="text-muted" />
          <span className="text-sm font-medium">{tx('点击选择二维码截图或照片')}</span>
          <span className="text-xs text-faint">{tx('支持 PNG / JPG / WebP')}</span>
          <input type="file" accept="image/*" className="hidden" onChange={e => { void onFile(e.target.files?.[0]) }} />
        </label>
      )}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
    </div>
  </div>
}
