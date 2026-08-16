import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import mammoth from 'mammoth'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// Turns an uploaded file into plain text for the session context.
// Supports: pdf, docx, csv, tsv, txt, md, json (and other plain-text files).
export async function parseFile(file) {
  const name = file.name.toLowerCase()
  const ext = name.split('.').pop()

  if (ext === 'pdf') return parsePdf(await file.arrayBuffer())

  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    return value
  }

  // CSV / TSV / TXT / MD / JSON and anything that's really just text.
  if (['csv', 'tsv', 'txt', 'md', 'json', 'log', 'xml', 'yaml', 'yml'].includes(ext)) {
    return await file.text()
  }

  // Old binary Office formats can't be read reliably in the browser.
  if (['doc', 'xls', 'ppt'].includes(ext)) {
    throw new Error(`${ext} is an old binary format — save it as .docx/.csv/.pdf and re-upload`)
  }

  // Last resort: try reading it as text; many unknown types are plain text.
  const text = await file.text()
  if (text && /[\x20-\x7E]/.test(text)) return text
  throw new Error('Unsupported file type: .' + ext)
}

async function parsePdf(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((it) => it.str).join(' ') + '\n'
  }
  return text.trim() // a scanned (image) PDF returns little here — it needs OCR
}
