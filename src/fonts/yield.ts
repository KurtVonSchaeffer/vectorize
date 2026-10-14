/**
 * Lets the page handle input and paint before continuing long main-thread work. Uses
 * scheduler.yield() where available, else a MessageChannel message: unlike setTimeout, neither is
 * slowed to once a second when the tab is in the background.
 */
export function yieldToPage(): Promise<void> {
  const s = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (s?.yield) return s.yield()
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => resolve()
    ch.port2.postMessage(null)
  })
}
