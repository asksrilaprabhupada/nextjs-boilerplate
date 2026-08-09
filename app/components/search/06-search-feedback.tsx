/**
 * 06-search-feedback.tsx — Search Feedback Widget
 *
 * Renders thumbs-up/thumbs-down voting buttons after search results are displayed.
 * Collects user feedback to help improve search quality over time.
 */
"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { logFeedback } from "../../lib/02-analytics";

interface SearchFeedbackProps {
  searchLogId: string | null;
}

export default function SearchFeedback({ searchLogId }: SearchFeedbackProps) {
  const [vote, setVote] = useState<1 | -1 | null>(null);
  const [showTextInput, setShowTextInput] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const handleVote = useCallback(async (v: 1 | -1) => {
    if (!searchLogId || vote !== null) return;
    setVote(v);

    // Thumbs down → show text input for why
    if (v === -1) {
      setShowTextInput(true);
    } else {
      // Thumbs up → send immediately
      setSending(true);
      await logFeedback(searchLogId, v);
      setSending(false);
      setSubmitted(true);
    }
  }, [searchLogId, vote]);

  const handleSubmitText = useCallback(async () => {
    if (!searchLogId || vote === null) return;
    setSending(true);
    await logFeedback(searchLogId, vote, feedbackText.trim() || undefined);
    setSending(false);
    setShowTextInput(false);
    setSubmitted(true);
  }, [searchLogId, vote, feedbackText]);

  const handleSkipText = useCallback(async () => {
    if (!searchLogId || vote === null) return;
    setSending(true);
    await logFeedback(searchLogId, vote);
    setSending(false);
    setShowTextInput(false);
    setSubmitted(true);
  }, [searchLogId, vote]);

  if (!searchLogId) return null;

  return (
    <div className="search-feedback">
      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="thanks"
            className="search-feedback__thanks"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <span className="search-feedback__thanks-icon" aria-hidden>🙏</span>
            <span className="search-feedback__thanks-copy font-body">
              Thank you for your feedback
            </span>
          </motion.div>
        ) : showTextInput ? (
          <motion.div
            key="text-input"
            className="search-feedback__form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <p className="search-feedback__prompt font-body">
              What could be improved?
            </p>
            <textarea
              value={feedbackText}
              onChange={e => setFeedbackText(e.target.value)}
              placeholder="The answer didn't address..., Wrong verses were shown..., etc."
              aria-label="What could be improved?"
              className="search-feedback__textarea font-body"
              rows={3}
            />
            <div className="search-feedback__actions">
              <button
                onClick={handleSubmitText}
                disabled={sending}
                className="search-feedback__action search-feedback__action--primary font-body"
              >
                {sending ? "Sending..." : "Submit"}
              </button>
              <button
                onClick={handleSkipText}
                disabled={sending}
                className="search-feedback__action search-feedback__action--secondary font-body"
              >
                Skip
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="vote-buttons"
            className="search-feedback__vote-row"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <span className="search-feedback__question font-body">
              Was this helpful?
            </span>

            {/* Thumbs Up */}
            <button
              onClick={() => handleVote(1)}
              disabled={sending}
              aria-label="Thumbs up"
              aria-pressed={vote === 1}
              data-selected={vote === 1 ? "true" : "false"}
              data-tone="up"
              className="search-feedback__vote"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m7-2V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Thumbs Down */}
            <button
              onClick={() => handleVote(-1)}
              disabled={sending}
              aria-label="Thumbs down"
              aria-pressed={vote === -1}
              data-selected={vote === -1 ? "true" : "false"}
              data-tone="down"
              className="search-feedback__vote"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M17 2H19.67a2 2 0 0 1 2 1.7l.33 2.3h0a2 2 0 0 1-2 2.3H14l1 4.5V17a3 3 0 0 1-3 3l-4-9V2h9zM7 2v11H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h3z"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <style jsx global>{`
        .search-feedback {
          width: 100%;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          margin-top: 8px;
          padding: 20px 0 4px;
          border-top: 1px solid var(--border-hair);
        }

        .search-feedback__thanks {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-width: 0;
          text-align: center;
        }

        .search-feedback__thanks-icon {
          flex: 0 0 auto;
          font-size: 16px;
        }

        .search-feedback__thanks-copy {
          overflow-wrap: anywhere;
          color: var(--accent-strong);
          font-size: 13px;
          font-weight: 500;
        }

        .search-feedback__form {
          width: 100%;
          max-width: 420px;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }

        .search-feedback__prompt {
          margin: 0;
          color: var(--ink-muted);
          font-size: 13px;
          text-align: center;
        }

        .search-feedback__textarea {
          width: 100%;
          min-width: 0;
          min-height: 88px;
          padding: 12px 14px;
          resize: vertical;
          overflow-wrap: anywhere;
          color: var(--ink);
          background: var(--surface-raised);
          border: 1px solid var(--border-hair);
          border-radius: 12px;
          font-size: 16px;
          line-height: 1.5;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .search-feedback__textarea:focus {
          border-color: var(--accent);
        }

        .search-feedback__actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 8px;
          width: 100%;
        }

        .search-feedback__action {
          min-width: 104px;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 10px 18px;
          border-radius: 10px;
          font-size: 13px;
          line-height: 1.2;
          cursor: pointer;
          transition: opacity 0.2s ease, border-color 0.2s ease, background 0.2s ease;
        }

        .search-feedback__action--primary {
          color: var(--on-accent);
          background: linear-gradient(135deg, var(--accent), var(--accent-strong));
          border: none;
          font-weight: 600;
        }

        .search-feedback__action--secondary {
          color: var(--ink-muted);
          background: transparent;
          border: 1px solid var(--border-hair);
          font-weight: 500;
        }

        .search-feedback__action:disabled,
        .search-feedback__vote:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }

        .search-feedback__vote-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 12px;
          min-width: 0;
        }

        .search-feedback__question {
          color: var(--ink-muted);
          font-size: 12px;
          font-weight: 500;
        }

        .search-feedback__vote {
          width: 44px;
          height: 44px;
          flex: 0 0 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--ink-muted);
          background: var(--surface-raised);
          border: 1px solid var(--border-hair);
          border-radius: 11px;
          cursor: pointer;
          transition: color 0.2s var(--ease-standard), background 0.2s var(--ease-standard), border-color 0.2s var(--ease-standard), transform 0.2s var(--ease-standard);
        }

        .search-feedback__vote[data-tone="up"]:hover:not(:disabled),
        .search-feedback__vote[data-tone="up"]:focus-visible,
        .search-feedback__vote[data-tone="up"][data-selected="true"] {
          color: #059669;
          background: rgba(16, 185, 129, 0.1);
          border-color: rgba(16, 185, 129, 0.3);
        }

        .search-feedback__vote[data-tone="down"]:hover:not(:disabled),
        .search-feedback__vote[data-tone="down"]:focus-visible,
        .search-feedback__vote[data-tone="down"][data-selected="true"] {
          color: #dc2626;
          background: rgba(239, 68, 68, 0.08);
          border-color: rgba(239, 68, 68, 0.3);
        }

        .search-feedback__vote:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .search-feedback__textarea:focus-visible,
        .search-feedback__action:focus-visible,
        .search-feedback__vote:focus-visible {
          outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent);
          outline-offset: 3px;
        }

        @media (max-width: 380px) {
          .search-feedback__question {
            flex-basis: 100%;
            text-align: center;
          }

          .search-feedback__action {
            flex: 1 1 120px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .search-feedback__textarea,
          .search-feedback__action,
          .search-feedback__vote {
            transition: none;
          }

          .search-feedback__vote:hover:not(:disabled) {
            transform: none;
          }
        }
      `}</style>
    </div>
  );
}
