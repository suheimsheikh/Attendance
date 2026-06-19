import React, { useEffect, useState } from "react";
import { Quote, BookOpen, Loader2 } from "lucide-react";
import { api } from "../api";

/**
 * Persistent bilingual content card shown on the Check-In page all day long.
 * Backend cycles between a motivational quote and an English-Telugu
 * word-of-the-day on alternate days. Content is generated once per day by
 * Gemini and cached server-side, so this component just GETs and renders.
 */
export default function DailyContent() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get("/daily-content")
      .then((d) => { if (alive) setData(d); })
      .catch(() => { /* silent — keep UI uncluttered if it ever fails */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <div
        className="iu-card p-5 mb-6 flex items-center gap-3 text-slate-400"
        data-testid="daily-content-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs">Loading today&apos;s message…</span>
      </div>
    );
  }
  if (!data) return null;

  const isWord = data.kind === "word";

  // Card styling: quote = sky/sailing palette; word = warm amber/teal for variety
  const wrapper = isWord
    ? "bg-gradient-to-br from-amber-50 via-white to-teal-50 ring-1 ring-amber-200/70"
    : "bg-gradient-to-br from-sky-50 via-white to-indigo-50 ring-1 ring-sky-200/70";
  const accent = isWord ? "text-amber-700" : "text-sky-700";
  const labelBg = isWord ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800";

  return (
    <div
      className={`relative rounded-2xl p-5 mb-6 shadow-sm ${wrapper}`}
      data-testid="daily-content"
      data-kind={data.kind}
    >
      <div className="flex items-center justify-between mb-3">
        <span className={`inline-flex items-center gap-1.5 px-2.5 h-6 rounded-full text-[11px] font-bold uppercase tracking-wider ${labelBg}`}>
          {isWord ? <BookOpen size={12} /> : <Quote size={12} />}
          {isWord ? "Word of the day" : "Quote of the day"}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold hidden sm:block">
          {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}
        </span>
      </div>

      {isWord ? (
        <div data-testid="daily-content-word">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className={`text-3xl md:text-4xl font-extrabold tracking-tight ${accent}`}>
              {data.en}
            </span>
            <span
              className="text-xl md:text-2xl font-bold text-slate-700"
              lang="te"
              style={{ fontFamily: "'Noto Sans Telugu', 'Inter', sans-serif" }}
              data-testid="daily-content-te"
            >
              {data.te}
            </span>
          </div>
          {(data.example_en || data.example_te) && (
            <div className="mt-3 border-t border-slate-200/60 pt-3 space-y-1.5">
              {data.example_en && (
                <p className="text-sm text-slate-700 italic" data-testid="daily-content-example-en">
                  &ldquo;{data.example_en}&rdquo;
                </p>
              )}
              {data.example_te && (
                <p
                  className="text-sm text-slate-600 italic"
                  lang="te"
                  style={{ fontFamily: "'Noto Sans Telugu', 'Inter', sans-serif" }}
                  data-testid="daily-content-example-te"
                >
                  &ldquo;{data.example_te}&rdquo;
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div data-testid="daily-content-quote">
          <p className={`text-lg md:text-xl font-semibold leading-snug ${accent}`}>
            &ldquo;{data.en}&rdquo;
          </p>
          <p
            className="text-sm md:text-base mt-2 italic text-slate-700 leading-snug"
            lang="te"
            style={{ fontFamily: "'Noto Sans Telugu', 'Inter', sans-serif" }}
            data-testid="daily-content-te"
          >
            &ldquo;{data.te}&rdquo;
          </p>
          {data.author && (
            <p className="text-xs mt-3 text-slate-500 font-semibold">— {data.author}</p>
          )}
        </div>
      )}
    </div>
  );
}
