import { createCanvas } from '@napi-rs/canvas'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Where pdfjs keeps the Type1 fonts it substitutes for unembedded ones.
 *
 * Resolved from the installed package rather than hardcoded, so it
 * survives a hoisted or nested node_modules layout. Without it, any PDF
 * relying on a standard font (Helvetica, Times — which is most business
 * paperwork) renders its text as blank space.
 */
const require = createRequire(import.meta.url)
const STANDARD_FONTS = pathToFileURL(
  join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts/'),
).href

/**
 * Render the first page of a PDF to a PNG.
 *
 * The vision model accepts only webp, png, jpeg and gif — a PDF sent
 * directly comes back as "unsupported image". So a claimant who emails
 * their repair estimate as a PDF, which is how most garages send them,
 * would otherwise have to print it and photograph it.
 *
 * First page only. Every document we ask for is a single page, and
 * rendering more would multiply the vision cost for pages the model
 * would then have to be told to ignore. If a multi-page document
 * arrives, the confirmation step catches the missing fields and asks
 * for a better copy — which is the right outcome anyway.
 */

/** Rendered wide enough for small print to survive; beyond this the
 *  vision model gains nothing and the upload gets slow. */
const TARGET_WIDTH = 1600
const MAX_SCALE = 3

let pdfjs = null

/**
 * Load pdfjs lazily.
 *
 * It is a heavy ESM module and most uploads are photographs, so a
 * server that never sees a PDF should never pay to import it.
 */
async function getPdfjs() {
  if (!pdfjs) {
    // The legacy build avoids pdfjs's browser-only worker setup.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjs
}

export function isPdf(dataUri) {
  return /^data:application\/pdf;base64,/i.test(dataUri)
}

/**
 * Turn a PDF data URI into a PNG data URI.
 *
 * Throws with a message a claimant can act on — this runs on their
 * upload, so "the PDF is password protected" has to reach them rather
 * than a stack trace.
 */
export async function pdfToImage(dataUri) {
  const base64 = dataUri.replace(/^data:application\/pdf;base64,/i, '')
  const bytes = Buffer.from(base64, 'base64')

  const { getDocument } = await getPdfjs()

  let task
  let doc
  try {
    task = getDocument({
      data: new Uint8Array(bytes),
      // Nothing in a claim document needs fonts fetched from the web,
      // and allowing it would let an uploaded file make requests.
      disableFontFace: true,
      isEvalSupported: false,
      standardFontDataUrl: STANDARD_FONTS,
    })
    doc = await task.promise
  } catch (err) {
    if (/password/i.test(err.message)) {
      throw new Error('that PDF is password protected')
    }
    throw new Error('that PDF could not be opened')
  }

  if (doc.numPages < 1) throw new Error('that PDF has no pages')

  const page = await doc.getPage(1)

  // Scale so the rendered width is legible without being wasteful.
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / base.width))
  const viewport = page.getViewport({ scale })

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')

  // PDFs assume paper. Without this, transparent areas render black and
  // the model reads a dark rectangle.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvasContext: context, viewport, canvas }).promise

  const png = canvas.toBuffer('image/png')
  const pages = doc.numPages
  await task.destroy()

  return {
    dataUri: `data:image/png;base64,${png.toString('base64')}`,
    pages,
    width: canvas.width,
    height: canvas.height,
  }
}
