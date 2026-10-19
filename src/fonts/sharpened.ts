/**
 * Small lettering is read from a sharpened copy when there is one; letters are still placed in
 * the original image's pixels, so the report's scale is made to account for the sharpening.
 * The sharpened copy is closed once read. Shared by the app and the improver benchmark.
 */
export async function readFromSharpened<R extends { scale: number }>(original: ImageBitmap, sharp: ImageBitmap | null, read: (image: ImageBitmap) => Promise<R>): Promise<R> {
  // Read before the sharpened copy is closed (a closed bitmap reports width 0).
  const sharpWidth = sharp?.width ?? 0
  const report = await read(sharp ?? original).finally(() => sharp?.close())
  if (sharp) report.scale *= sharpWidth / original.width
  return report
}
