import { useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessionModel } from "../lib/useSessionModel";
import { buildFacts } from "../engine/index.ts";
import { F, sty } from "../lib/styles";

interface RaceAgentProps {
  raceMeta?: { meetingName?: string; circuit?: string; country?: string; year?: number; sessionName?: string };
}

export default function RaceAgent({ raceMeta }: RaceAgentProps) {
  const { model } = useSessionModel();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [toolsUsed, setToolsUsed] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function askAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!model || !question.trim() || loading) return;
    setLoading(true);
    setError("");
    setAnswer("");
    setToolsUsed([]);
    try {
      const facts = buildFacts(model);
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim(), facts, raceMeta }),
      });
      const raw = await res.text();

      let data: any;
      try {
       data = JSON.parse(raw);
      } catch {
         throw new Error(
         `Agent server returned an empty or invalid response (HTTP ${res.status}). Check the Vite terminal for the server error.`,
   );
}

if (!res.ok) {
  throw new Error(data?.error || `Request failed (${res.status})`);
}
      setAnswer(typeof data.answer === "string" ? data.answer : "No answer was returned.");
      setToolsUsed(Array.isArray(data.toolsUsed) ? data.toolsUsed : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ ...sty.card, marginBottom: 16 }}>
      <div style={{ ...sty.sectionHead, marginBottom: 8 }}>RaceVector AI Race Engineer</div>
      <p style={{ color: "#b0b0c0", fontSize: 12, lineHeight: 1.6, margin: "0 0 14px" }}>
        Ask a question about this session. The agent can call race-data tools for pace, tyre degradation, driver evidence, and strategy.
      </p>
      <form onSubmit={askAgent} style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input
          aria-label="Ask the RaceVector agent"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          maxLength={800}
          placeholder="e.g. Which drivers had the strongest race pace?"
          disabled={loading || !model}
          style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.05)", color: "#e8e8ec", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "11px 12px", fontFamily: F, fontSize: 12 }}
        />
        <button type="submit" disabled={loading || !model || !question.trim()} style={{ background: "linear-gradient(135deg, #e10600, #a855f7)", color: "#fff", border: 0, borderRadius: 8, padding: "0 16px", fontSize: 12, fontWeight: 700, cursor: loading ? "wait" : "pointer", fontFamily: F, opacity: loading || !question.trim() ? 0.6 : 1 }}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>
      {error && <div role="alert" style={{ color: "#fca5a5", fontSize: 12, marginTop: 12 }}>{error}</div>}
      {answer && <div className="ai-markdown" style={{ marginTop: 16, color: "#c8c8d0", fontSize: 13, lineHeight: 1.7 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown></div>}
      {toolsUsed.length > 0 && <div style={{ color: "#9ca3af", fontSize: 10, marginTop: 12 }}>Tools used: {toolsUsed.map(tool => tool.replaceAll("_", " ")).join(" · ")}</div>}
      <style>{`.ai-markdown h1,.ai-markdown h2,.ai-markdown h3{color:#e8e8ec;margin:14px 0 6px}.ai-markdown table{width:100%;border-collapse:collapse}.ai-markdown th,.ai-markdown td{border:1px solid rgba(255,255,255,.12);padding:6px;text-align:left}.ai-markdown strong{color:#e8e8ec}`}</style>
    </div>
  );
}
