'use client';

import { useEffect, useRef, useState } from 'react';
import { QuestionnaireItem } from '@/lib/types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const STATUS_COLORS: Record<string, string> = {
  verified: '#3fb950',
  vague: '#7ee787',
  conflict: '#d29922',
  unknown: '#8b949e',
  confirmed: '#58a6ff',
  not_applicable: '#484f58',
};

const STATUS_LABELS: Record<string, string> = {
  verified: 'Verified from docs',
  vague: 'Partially answered — needs clarification',
  conflict: 'Conflict — needs review',
  unknown: 'Unknown — needs input',
  confirmed: 'Confirmed by user',
  not_applicable: 'Not applicable',
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [pendingFollowUp, setPendingFollowUp] = useState<string | null>(null);
  const [items, setItems] = useState<QuestionnaireItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshBoard = async () => {
    const res = await fetch('/api/questionnaire');
    const data = await res.json();
    setItems(data.items);
    setSummary(data.summary);
  };

  const bootstrap = async () => {
    setLoading(true);
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '__start__', currentItemId: null }),
    });
    const data = await res.json();
    setMessages([{ role: 'assistant', content: data.reply }]);
    setCurrentItemId(data.currentItemId);
    await refreshBoard();
    setLoading(false);
  };

  useEffect(() => {
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setMessages((m) => [...m, { role: 'user', content: userMsg }]);
    setInput('');
    setLoading(true);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: userMsg, currentItemId, pendingFollowUp }),
    });
    const data = await res.json();
    setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
    setCurrentItemId(data.currentItemId);
    setPendingFollowUp(data.pendingFollowUp ?? null);
    await refreshBoard();
    setLoading(false);
  };

  const CoverageBar = () => {
    if (!summary) return null;
    const segments = [
      { label: 'Verified', count: summary.verified, color: '#3fb950' },
      { label: 'Vague', count: summary.vague, color: '#7ee787' },
      { label: 'Conflict', count: summary.conflict, color: '#d29922' },
      { label: 'Unknown', count: summary.unknown, color: '#8b949e' },
      { label: 'Confirmed', count: summary.confirmed, color: '#58a6ff' },
      { label: 'N/A', count: summary.not_applicable, color: '#484f58' },
    ].filter((s) => s.count > 0);

    return (
      <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#8b949e', flexWrap: 'wrap' }}>
        {segments.map((seg) => (
          <div key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 12, height: 12, borderRadius: 3, background: seg.color }} />
            <span>
              {seg.count} {seg.label}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Chat panel */}
      <div style={{ flex: 2, display: 'flex', flexDirection: 'column', borderRight: '1px solid #30363d' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #30363d' }}>
          <h2 style={{ margin: 0 }}>Regodit AI Security Analyst</h2>
          <CoverageBar />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {messages.map((m, i) => {
            const isOpener = i === 0 && m.role === 'assistant';
            return (
              <div
                key={i}
                style={{
                  marginBottom: isOpener ? 24 : 14,
                  textAlign: m.role === 'user' ? 'right' : 'left',
                }}
              >
                <div
                  style={{
                    display: 'inline-block',
                    maxWidth: '75%',
                    padding: isOpener ? '16px 18px' : '10px 14px',
                    borderRadius: isOpener ? 14 : 10,
                    background: isOpener ? '#161b2280' : m.role === 'user' ? '#1f6feb' : '#161b22',
                    border: isOpener ? '1px solid #30363d' : 'none',
                    whiteSpace: 'pre-wrap',
                    textAlign: 'left',
                    fontSize: isOpener ? 15 : 'inherit',
                    lineHeight: isOpener ? 1.5 : 'inherit',
                  }}
                >
                  {m.content}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
        <div style={{ padding: 16, borderTop: '1px solid #30363d', display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Type your answer..."
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #30363d',
              background: '#0d1117',
              color: '#e6edf3',
            }}
          />
          <button
            onClick={send}
            disabled={loading}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: 'none',
              background: '#238636',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            Send
          </button>
        </div>
      </div>

      {/* Knowledge base dashboard */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>Knowledge Base</h3>
        {items.map((item) => (
          <div
            key={item.id}
            style={{
              border: `1px solid ${STATUS_COLORS[item.status]}55`,
              borderLeft: `4px solid ${STATUS_COLORS[item.status]}`,
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 10,
              background: item.id === currentItemId ? '#161b2280' : 'transparent',
            }}
          >
            <div style={{ fontSize: 13, color: STATUS_COLORS[item.status], fontWeight: 600 }}>
              {STATUS_LABELS[item.status]}
            </div>
            <div style={{ fontWeight: 500, margin: '4px 0' }}>{item.question}</div>
            {item.answer && <div style={{ fontSize: 13, color: '#c9d1d9', marginTop: 6 }}>{item.answer}</div>}
            {item.evidence.length > 0 && (
              <details style={{ fontSize: 12, color: '#8b949e', marginTop: 8, cursor: 'pointer' }}>
                <summary style={{ fontWeight: 500, color: '#a371f7', cursor: 'pointer' }}>
                  Evidence ({item.evidence.length}) →
                </summary>
                <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid #30363d' }}>
                  {item.evidence.map((e, i) => (
                    <div key={i} style={{ marginBottom: 8, color: '#c9d1d9', fontSize: 12 }}>
                      <div style={{ fontWeight: 500, color: '#58a6ff' }}>{e.doc}</div>
                      {e.section && <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>Section: {e.section}</div>}
                      {e.detail && (
                        <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2, fontStyle: 'italic' }}>
                          "{e.detail.slice(0, 100)}{e.detail.length > 100 ? '...' : ''}"
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
