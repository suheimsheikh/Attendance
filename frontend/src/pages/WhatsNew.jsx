import React, { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { api } from "../api";

/**
 * What's New / Changelog viewer. Reads the repo `CHANGELOG.md` via
 * `GET /api/changelog` and renders it with a tiny markdown subset so we
 * don't have to pull in react-markdown. Handles: # / ## / ### headings,
 * bullets, **bold**, `code`, links, emoji, blank lines.
 */
export default function WhatsNew() {
  const [md, setMd] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get("/changelog");
        setMd(res?.markdown || "");
      } finally { setLoading(false); }
    })();
  }, []);

  if (loading) {
    return <div className="p-8 text-center text-slate-400" data-testid="whats-new-loading"><Loader2 className="animate-spin mx-auto" /></div>;
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="whats-new-page">
      <header className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl bg-sky-600 text-white flex items-center justify-center shadow-sm shrink-0">
          <Sparkles size={20} />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">What&apos;s New</h1>
          <p className="text-sm text-slate-500 mt-0.5">Improvements & features shipped recently.</p>
        </div>
      </header>
      <article className="iu-card p-6 space-y-4 whats-new-md">
        {renderMarkdown(md)}
      </article>
    </div>
  );
}

// Minimal markdown renderer — supports the subset we use in CHANGELOG.md
// (headings, bullets, bold, code, links, emoji). Outputs an array of React
// nodes so we can preserve key uniqueness for the React reconciler.
function renderMarkdown(md) {
  if (!md) return <p className="text-slate-400 text-sm">Nothing here yet.</p>;
  const lines = md.split(/\r?\n/);
  const out = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(
        <ul key={`ul-${out.length}`} className="list-disc pl-5 space-y-1.5 text-sm text-slate-700">
          {listBuf.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>
      );
      listBuf = [];
    }
  };

  for (let raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*<!--/.test(line) || /-->\s*$/.test(line)) continue;
    if (/^\s*---\s*$/.test(line)) {
      flushList();
      out.push(<hr key={`hr-${out.length}`} className="border-slate-200" />);
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      out.push(<h3 key={`h3-${out.length}`} className="text-base font-bold text-slate-900 mt-4">{renderInline(line.slice(4))}</h3>);
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      out.push(<h2 key={`h2-${out.length}`} className="text-lg font-extrabold text-slate-900 mt-6 border-b border-slate-200 pb-1">{renderInline(line.slice(3))}</h2>);
      continue;
    }
    if (line.startsWith("# ")) {
      flushList();
      out.push(<h1 key={`h1-${out.length}`} className="text-2xl font-extrabold text-slate-900 mt-2">{renderInline(line.slice(2))}</h1>);
      continue;
    }
    const liMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (liMatch) { listBuf.push(liMatch[1]); continue; }
    flushList();
    if (line.trim() === "") continue;
    out.push(<p key={`p-${out.length}`} className="text-sm text-slate-700 leading-relaxed">{renderInline(line)}</p>);
  }
  flushList();
  return out;
}

// Inline markdown: **bold**, `code`, [link](href).
function renderInline(text) {
  const parts = [];
  let rest = text;
  let i = 0;
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/;
  while (true) {
    const m = re.exec(rest);
    if (!m) { if (rest) parts.push(rest); break; }
    if (m.index > 0) parts.push(rest.slice(0, m.index));
    i++;
    if (m[2] != null) parts.push(<strong key={`b-${i}`} className="font-bold text-slate-900">{m[2]}</strong>);
    else if (m[3] != null) parts.push(<code key={`c-${i}`} className="text-[12px] bg-slate-100 text-slate-800 px-1 py-0.5 rounded">{m[3]}</code>);
    else if (m[4] != null) parts.push(<a key={`a-${i}`} href={m[5]} target="_blank" rel="noreferrer" className="text-sky-700 underline">{m[4]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  return parts;
}
