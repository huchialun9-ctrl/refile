import type { FileMeta } from './peer'

/** Accumulates chunks from a WebRTC DataChannel and fires callbacks. */
export class FileReceiver {
  private meta: FileMeta | null = null
  private chunks: ArrayBuffer[] = []
  private received = 0

  onProgress?: (received: number, total: number, name: string) => void
  onComplete?: (blob: Blob, name: string) => void

  setMeta(meta: FileMeta) {
    this.meta = meta
    this.chunks = []
    this.received = 0
  }

  addChunk(chunk: ArrayBuffer) {
    if (!this.meta) return
    this.chunks.push(chunk)
    this.received += chunk.byteLength
    this.onProgress?.(this.received, this.meta.size, this.meta.name)

    if (this.received >= this.meta.size) {
      const blob = new Blob(this.chunks, { type: this.meta.mime })
      const name = this.meta.name
      this.meta = null
      this.chunks = []
      this.received = 0
      this.onComplete?.(blob, name)
    }
  }
}
