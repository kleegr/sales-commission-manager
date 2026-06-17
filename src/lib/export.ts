// Export helpers — CSV download and a print-window approach for PDF that needs
// no external dependency (the browser's "Save as PDF" handles the rest).

export function downloadCSV(filename: string, rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename.endsWith(".csv") ? filename : `${filename}.csv`);
}

export function downloadJSON(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, filename.endsWith(".json") ? filename : `${filename}.json`);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Open a printable window with the given HTML and trigger the print dialog,
 * where the user can choose "Save as PDF". Works without bundling a PDF lib.
 */
export function printHTMLToPDF(title: string, bodyHTML: string) {
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) {
    alert("Please allow pop-ups to export a PDF.");
    return;
  }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; color: #475569; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
  th { background: #f8fafc; }
  .muted { color: #64748b; font-size: 12px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; min-width: 150px; }
  .card .l { font-size: 11px; color: #64748b; text-transform: uppercase; }
  .card .v { font-size: 18px; font-weight: 600; }
  @media print { @page { margin: 16mm; } }
</style></head><body>${bodyHTML}
<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 250); };</script>
</body></html>`);
  win.document.close();
}
