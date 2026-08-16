import { jsPDF } from 'jspdf'

// Light cleanup so markdown symbols don't show up as raw ** and # in the PDF.
function clean(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1') // bold
    .replace(/^#{1,6}\s*/gm, '')      // headings
    .replace(/^\s*[-*]\s+/gm, '• ')   // bullets
}

// Builds a PDF from the notes text and triggers a download.
export function downloadNotesPdf(notes, title = 'Meeting Notes') {
  if (!notes || typeof notes !== 'string' || !notes.trim()) return false

  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const margin = 48
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const width = pageW - margin * 2

  doc.setFont('helvetica', 'bold').setFontSize(16)
  doc.text(title, margin, 60)

  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(120)
  doc.text(new Date().toLocaleString(), margin, 78)

  doc.setFontSize(11).setTextColor(20)
  const lines = doc.splitTextToSize(clean(notes), width)
  let y = 106
  const lineH = 16
  for (const line of lines) {
    if (y > pageH - margin) { doc.addPage(); y = 60 }
    doc.text(line, margin, y)
    y += lineH
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  doc.save(`meeting-notes-${stamp}.pdf`)
  return true
}
