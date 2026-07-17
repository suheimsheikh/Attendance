/**
 * HelpChat — a floating "Ask for help" bubble in the bottom-right of
 * every authenticated page. Clicking it opens a Claude-powered chat
 * drawer that can answer both instructional questions ("how do I file
 * a leave?") and personalised ones ("how many late days do I have
 * this year?") because the backend injects the user's own attendance
 * snapshot into the system prompt on every turn.
 *
 * Session lifecycle:
 *   * `session_id` is server-issued on the first turn and stashed in
 *     localStorage so refreshing the page keeps the conversation.
 *   * Clicking "New chat" resets both — server drops its LlmChat
 *     instance, client wipes the message list.
 *
 * Streaming is over SSE (fetch + reader). Deltas append to the
 * current assistant message so tokens appear as Claude types them.
 *
 * 18 Feb 2026 — user request: "Can we have a help routine by Claude
 * at the bottom right corner of the app".
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { HelpCircle, X, Send, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { getToken } from "../api";

const STORAGE_KEY = "help_chat_session_v1";
const BACKEND = process.env.REACT_APP_BACKEND_URL;

const seedGreeting = (name, isAdmin) => ({
  role: "assistant",
  content: isAdmin
    ? `Hi ${name?.split(" ")[0] || "there"}! I'm your in-app assistant. Ask me anything about The Grid, reports, approvals, muster, or how to fix a member's record.`
    : `Hi ${name?.split(" ")[0] || "there"}! Ask me anything about filing a leave, why your attendance shows a certain way, or how to correct a wrong check-in.`,
});

export default function HelpChat() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState(() => []);
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
  });
  const bodyRef = useRef(null);
  const abortRef = useRef(null);

  // First-open — seed a friendly greeting if we don't have any turns yet.
  useEffect(() => {
    if (open && messages.length === 0 && user) {
      setMessages([seedGreeting(user.full_name, user.role === "admin")]);
    }
  }, [open, messages.length, user]);

  // Auto-scroll to the latest turn whenever the message list grows.
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages, sending]);

  // Cancel any in-flight stream if the widget closes or unmounts.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    // Push user turn + a placeholder assistant turn we'll append deltas to.
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = getToken();
      const resp = await fetch(`${BACKEND}/api/help/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({ message: text, session_id: sessionId, page: pathname }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        let msg = "Sorry — something went wrong. Please try again.";
        if (resp.status === 429) msg = "Whoa! Slow down — you've asked a lot in the last minute. Please wait 60s and try again.";
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: msg };
          return copy;
        });
        return;
      }
      // Parse the SSE stream — each event is `event: X\ndata: {...}\n\n`.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Process every complete SSE frame in the buffer.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evMatch = frame.match(/^event:\s*(\w+)/m);
          const dataMatch = frame.match(/^data:\s*(.*)$/m);
          if (!dataMatch) continue;
          const evType = evMatch ? evMatch[1] : "message";
          let payload;
          try { payload = JSON.parse(dataMatch[1]); } catch { continue; }
          if (evType === "session") {
            setSessionId(payload.session_id);
            try { localStorage.setItem(STORAGE_KEY, payload.session_id); } catch { /* ignore */ }
          } else if (evType === "error") {
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { role: "assistant", content: `Error: ${payload.error || "unknown"}` };
              return copy;
            });
          } else if (evType === "done") {
            // no-op — end of stream
          } else if (payload.delta) {
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, content: (last.content || "") + payload.delta };
              return copy;
            });
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content: "Couldn't reach the assistant. Please try again in a moment." };
        return copy;
      });
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [input, sending, sessionId, pathname]);

  const resetChat = useCallback(async () => {
    if (sessionId) {
      try {
        const token = getToken();
        await fetch(`${BACKEND}/api/help/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: token ? `Bearer ${token}` : "" },
          body: JSON.stringify({ message: "reset", session_id: sessionId }),
        });
      } catch { /* non-fatal */ }
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setSessionId(null);
    setMessages(user ? [seedGreeting(user.full_name, user.role === "admin")] : []);
  }, [sessionId, user]);

  if (!user) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          data-testid="help-chat-fab"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 h-14 w-14 rounded-full bg-slate-900 text-white shadow-xl hover:bg-slate-800 hover:scale-105 transition-transform flex items-center justify-center ring-4 ring-white"
          aria-label="Open help chat"
          title="Ask for help"
        >
          <HelpCircle size={26} />
        </button>
      )}

      {open && (
        <div
          data-testid="help-chat-drawer"
          className="fixed bottom-5 right-5 z-40 w-[min(94vw,420px)] h-[min(80vh,600px)] bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-slate-900 to-slate-800 text-white">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-amber-300"/>
              <div>
                <div className="text-sm font-bold">Help · Ask anything</div>
                <div className="text-[10px] text-slate-300">Powered by Claude · your data stays private</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="help-chat-reset"
                onClick={resetChat}
                className="p-1.5 rounded hover:bg-white/10"
                title="Start a new chat"
              ><RotateCcw size={14}/></button>
              <button
                type="button"
                data-testid="help-chat-close"
                onClick={() => setOpen(false)}
                className="p-1.5 rounded hover:bg-white/10"
                title="Close"
              ><X size={16}/></button>
            </div>
          </div>

          {/* Body */}
          <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50" data-testid="help-chat-body">
            {messages.map((m, i) => (
              <div
                key={i}
                data-testid={`help-chat-msg-${m.role}`}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-slate-900 text-white rounded-br-sm"
                      : "bg-white text-slate-800 ring-1 ring-slate-200 rounded-bl-sm"
                  }`}
                >
                  {m.content || (sending && i === messages.length - 1 ? (
                    <span className="inline-flex items-center gap-1 text-slate-400"><Loader2 size={12} className="animate-spin"/> thinking…</span>
                  ) : "")}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            className="p-2 bg-white border-t border-slate-200 flex items-center gap-2"
          >
            <input
              data-testid="help-chat-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={sending ? "Waiting for reply…" : "Type your question…"}
              disabled={sending}
              className="flex-1 iu-input !h-10 text-sm"
              autoFocus
            />
            <button
              type="submit"
              data-testid="help-chat-send"
              disabled={sending || !input.trim()}
              className="iu-btn-primary !h-10 !w-10 !p-0 justify-center disabled:opacity-40"
              aria-label="Send"
            >{sending ? <Loader2 size={14} className="animate-spin"/> : <Send size={14}/>}</button>
          </form>
        </div>
      )}
    </>
  );
}
