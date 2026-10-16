import { useState, useCallback, useRef, useEffect } from "react";
import { useSessionModel } from "../lib/useSessionModel";
import { buildFacts } from "../engine/index.ts";
import { F, M, sty } from "../lib/styles";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import RaceAgent from "./RaceAgent";

interface AIAnalysisProps {
  allLaps: any[];
  drivers: any[];
  stints: any[];
  pits: any[];
  weather: any[];
  raceControl: any[];
  results: any[];
  raceMeta?: { meetingName?: string; circuit?: string; country?: string; year?: number; sessionName?: string };
}

export default function AIAnalysis({ allLaps, raceMeta }: AIAnalysisProps) {
  const { model } = useSessionModel();
  const [analysis, setAnalysis] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chunkRef = useRef("");
  const rafRef = useRef(0);

  // Reset when race data changes, abort on unmount
  useEffect(() => {
    abortRef.current?.abort();
    cancelAnimationFrame(rafRef.current);
    setAnalysis("");
    setError("");
    setLoading(false);
    return () => {
      abortRef.current?.abort();
      cancelAnimationFrame(rafRef.current);
    };
  }, [allLaps]);

  // Auto-scroll as text streams in
  useEffect(() => {
    if (loading && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [analysis, loading]);

  const generate = useCallback(async () => {
    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    setAnalysis("");
    chunkRef.current = "";

    try {
      // The same facts the verdicts and the export are built from.
      if (!model) throw new Error("Session data not loaded yet.");
      const facts = buildFacts(model);
      const payload = raceMeta ? { ...facts, raceMeta } : facts;

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Batch updates via requestAnimationFrame to avoid O(n^2) re-renders
      const flushChunks = () => {
        const pending = chunkRef.current;
        if (pending) {
          chunkRef.current = "";
          setAnalysis(prev => prev + pending);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              chunkRef.current += parsed.text;
              cancelAnimationFrame(rafRef.current);
              rafRef.current = requestAnimationFrame(flushChunks);
            }
            if (parsed.error) {
              throw new Error(parsed.error);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Flush any remaining text
      flushChunks();
    } catch (e: any) {
      if (e.name === "AbortError") return;
      setError(e.message || "Failed to generate analysis");
    }
    setLoading(false);
  }, [model, raceMeta]);

  // Initial state — no analysis yet
  if (!analysis && !loading && !error) {
    return (
      <div style={sty.card}>
        <RaceAgent raceMeta={raceMeta} />
        <div style={{ textAlign: "center", padding: 30 }}>
          <div style={{
            width: 48, height: 48, margin: "0 auto 16px",
            background: "linear-gradient(135deg, rgba(225,6,0,0.15), rgba(168,85,247,0.15))",
            borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24,
          }}>
            &#9733;
          </div>
          <div style={{ ...sty.sectionHead, marginBottom: 12 }}>AI Race Analysis</div>
          <p style={{ color: "#b0b0c0", fontSize: 13, marginBottom: 20, lineHeight: 1.6, maxWidth: 480, margin: "0 auto 20px" }}>
            Generate an expert race breakdown powered by AI — covering strategy, pace, tire management, key battles, and a race verdict. All insights are derived from the telemetry data.
          </p>
          <button onClick={generate} style={{
            background: "linear-gradient(135deg, #e10600, #a855f7)",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "12px 32px",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: F,
            letterSpacing: "0.3px",
            transition: "all 0.2s ease",
          }}>
            Generate AI Analysis
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={sty.card}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={sty.sectionHead}>AI Race Analysis</span>
          {loading && (
            <span style={{
              fontSize: 10, color: "#a855f7", fontWeight: 600, fontFamily: M,
              animation: "pulse 1.5s ease-in-out infinite",
            }}>
              analyzing...
            </span>
          )}
        </div>
        {!loading && analysis && (
          <button onClick={generate} style={{
            background: "rgba(255,255,255,0.06)",
            color: "#b0b0c0",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6,
            padding: "6px 14px",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: F,
            transition: "all 0.2s ease",
          }}>
            Regenerate
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: "rgba(220, 38, 38, 0.12)",
          border: "1px solid rgba(220, 38, 38, 0.2)",
          padding: "12px 16px",
          borderRadius: 8,
          fontSize: 12,
          color: "#fca5a5",
          marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {/* Content */}
      <div
        ref={contentRef}
        className="ai-markdown"
        style={{
          fontSize: 13,
          color: "#c8c8d0",
          fontFamily: F,
          lineHeight: 1.7,
          maxHeight: 600,
          overflowY: "auto",
          paddingRight: 8,
        }}
      >

        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {analysis
            .replace(/^[ \t]*\\\|/gm, "|")
            .replace(/^[ \t]*\\---[ \t]*$/gm, "---")
            .replace(/(\|[^\n]*\n)[ \t]*\n(?=[ \t]*\|)/g, "$1")}
        </ReactMarkdown>
      </div>

      {/* Inline keyframes */}
      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }


.ai-markdown h1 {
  color: #e8e8ec;
  font-size: 20px;
  font-weight: 800;
  margin: 16px 0 10px;
}

.ai-markdown h2 {
  color: #e10600;
  font-size: 16px;
  font-weight: 800;
  margin: 20px 0 8px;
  border-bottom: 1px solid rgba(225, 6, 0, 0.2);
  padding-bottom: 6px;
}

.ai-markdown p {
  margin: 6px 0;
  line-height: 1.7;
}

.ai-markdown table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0 18px;
  font-size: 12px;
}

.ai-markdown th,
.ai-markdown td {
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 8px;
  text-align: left;
  vertical-align: top;
}

.ai-markdown th {
  background: rgba(225, 6, 0, 0.12);
  color: #e8e8ec;
}

.ai-markdown strong {
  color: #e8e8ec;
  font-weight: 700;
}

.ai-markdown hr {
  border: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  margin: 18px 0;
}

.ai-markdown ul,
.ai-markdown ol {
  padding-left: 22px;
}

.ai-markdown li {
  margin-bottom: 5px;
}

      `}</style>
    </div>
  );
}
