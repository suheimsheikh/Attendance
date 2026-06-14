import QRCode from "qrcode";
import { Platform } from "react-native";

export type PrintMember = {
  id: string;
  full_name: string;
  rank?: string | null;
  category: string;
  personal_qr?: string | null;
};

const CAT_LABEL: Record<string, string> = { sailor: "Sailor", staff: "Staff", coach: "Coach" };

function escapeHtml(s?: string | null): string {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

async function qrDataUrl(text: string, size: number): Promise<string> {
  return QRCode.toDataURL(text, { width: size, margin: 1, errorCorrectionLevel: "M" });
}

function card(title: string, subtitle: string, img: string, code: string, hint: string, big = false): string {
  return `<div class="card${big ? " big" : ""}">
    <div class="name">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ""}
    <img src="${img}" alt="QR" />
    <div class="code">${escapeHtml(code)}</div>
    <div class="hint">${escapeHtml(hint)}</div>
  </div>`;
}

export async function printQRSheet(opts: {
  officeQr?: string | null;
  officeName?: string | null;
  members?: PrintMember[];
  includeOffice?: boolean;
  includeMembers?: boolean;
}): Promise<{ ok: boolean; reason?: string }> {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return { ok: false, reason: "Printing is available on the desktop web console." };
  }
  const win = window.open("", "_blank");
  if (!win) return { ok: false, reason: "Please allow pop-ups to print QR codes." };
  win.document.write("<!doctype html><html><body style='font-family:sans-serif;padding:48px;color:#374151'>Generating QR codes…</body></html>");

  let sections = "";
  if (opts.includeOffice && opts.officeQr) {
    const img = await qrDataUrl(opts.officeQr, 460);
    sections += `<div class="page office">${card(opts.officeName || "Club Office", "Master Gate QR", img, opts.officeQr, "Mount at the entrance — everyone scans this to check in / out", true)}</div>`;
  }
  if (opts.includeMembers && opts.members?.length) {
    const valid = opts.members.filter((m) => m.personal_qr);
    const cards = await Promise.all(
      valid.map(async (m) => {
        const img = await qrDataUrl(m.personal_qr as string, 240);
        const sub = [m.rank, CAT_LABEL[m.category] || m.category].filter(Boolean).join(" · ");
        return card(m.full_name, sub, img, m.personal_qr as string, "Scan at the gate to mark attendance");
      })
    );
    if (cards.length) {
      sections += `<div class="grid">${cards.join("")}</div>`;
    }
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Attendance — QR Cards</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;margin:0;padding:24px;color:#111827;background:#fff}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .card{border:1.5px dashed #9CA3AF;border-radius:14px;padding:16px;text-align:center;page-break-inside:avoid}
    .card img{width:200px;height:200px}
    .card.big{border-style:solid;border-width:2px;border-color:#111827;max-width:520px;margin:0 auto}
    .card.big img{width:380px;height:380px}
    .page.office{text-align:center;page-break-after:always;padding-top:24px}
    .card .name{font-size:18px;font-weight:800}
    .card.big .name{font-size:30px}
    .card .sub{font-size:13px;color:#6B7280;margin-top:2px}
    .card .code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#374151;margin-top:8px;letter-spacing:1px}
    .card .hint{font-size:11px;color:#9CA3AF;margin-top:6px}
    @media print{@page{margin:12mm}body{padding:0}.no-print{display:none}}
  </style></head>
  <body>
    <div class="no-print" style="text-align:center;margin-bottom:18px">
      <button onclick="window.print()" style="background:#111827;color:#fff;border:0;padding:10px 24px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer">🖨 Print</button>
    </div>
    ${sections || '<p style="text-align:center;color:#6B7280">No QR codes to print yet.</p>'}
  </body></html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
  setTimeout(() => { try { win.focus(); win.print(); } catch { /* user can use the Print button */ } }, 500);
  return { ok: true };
}
