import type { AnnotationQueueEntry, AnnotationQueueStore } from "./types.js"

const STORAGE_KEY = "opencodeChromeAnnotationQueues"

function storage(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.session || chrome.storage?.local
}

function normalizeEntry(entry: unknown): AnnotationQueueEntry | null {
  if (!entry || typeof entry !== "object") return null
  const raw = entry as Partial<AnnotationQueueEntry>
  const comment = typeof raw.comment === "string" ? raw.comment : ""
  if (!comment && !raw.element) return null
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    comment,
    element: raw.element || null,
    viewport: raw.viewport || null,
    page: raw.page || null,
    screenshot:
      raw.screenshot && typeof raw.screenshot.dataUrl === "string"
        ? {
            mime: typeof raw.screenshot.mime === "string" ? raw.screenshot.mime : "image/png",
            dataUrl: raw.screenshot.dataUrl,
          }
        : null,
    createdAt: Number.isFinite(raw.createdAt) ? (raw.createdAt as number) : Date.now(),
  } as AnnotationQueueEntry
}

export function createAnnotationQueueStore(): AnnotationQueueStore {
  const queues = new Map<number, AnnotationQueueEntry[]>()

  async function save(): Promise<void> {
    const area = storage()
    if (!area) return
    await area.set({ [STORAGE_KEY]: Array.from(queues.entries()) })
  }

  return {
    async restore(): Promise<void> {
      const area = storage()
      if (!area) return
      const result = await area.get(STORAGE_KEY)
      const entries = Array.isArray(result?.[STORAGE_KEY]) ? (result[STORAGE_KEY] as unknown[]) : []
      queues.clear()
      for (const pair of entries as Array<[unknown, unknown]>) {
        const [tabId, list] = pair
        if (!Number.isFinite(Number(tabId)) || !Array.isArray(list)) continue
        const normalized = list.map(normalizeEntry).filter((item): item is AnnotationQueueEntry => Boolean(item))
        if (normalized.length) queues.set(Number(tabId), normalized)
      }
    },

    list(tabId: number | undefined): AnnotationQueueEntry[] {
      if (tabId === undefined) return []
      const list = queues.get(tabId)
      return list ? list.slice() : []
    },

    async add(tabId: number, entry: unknown): Promise<string | null> {
      const normalized = normalizeEntry(entry)
      if (!normalized) return null
      const list = queues.get(tabId) || []
      list.push(normalized)
      queues.set(tabId, list)
      await save()
      return normalized.id
    },

    async remove(tabId: number, id: string): Promise<boolean> {
      const list = queues.get(tabId)
      if (!list) return false
      const next = list.filter((entry) => entry.id !== id)
      if (next.length === list.length) return false
      if (next.length) queues.set(tabId, next)
      else queues.delete(tabId)
      await save()
      return true
    },

    async clear(tabId: number): Promise<boolean> {
      if (!queues.delete(tabId)) return false
      await save()
      return true
    },

    async take(tabId: number): Promise<AnnotationQueueEntry[]> {
      const list = queues.get(tabId) || []
      queues.delete(tabId)
      await save()
      return list
    },

    delete(tabId: number): void {
      queues.delete(tabId)
      save().catch(() => {})
    },
  }
}
