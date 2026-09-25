// Candidate-only: feedback on the candidate's own answers.
//
// Initialised only for the candidate, and the server only sends `answer_evaluation`
// when the interview was created in practice mode. The interviewer's evaluation
// panel is a separate, richer view and is unaffected by this one.
//
// Scores are displayed exactly as the evaluator returned them (0–100 weighted);
// nothing here recomputes or rescales.

const $ = (id) => document.getElementById(id);

// The evaluator's real rubric dimensions and their weights, so the candidate
// sees the same breakdown the score was actually computed from.
const DIMENSIONS = [
  ['correctness', 'Correctness', 40],
  ['completeness', 'Completeness', 25],
  ['relevance', 'Relevance', 15],
  ['technicalDepth', 'Technical depth', 10],
  ['clarity', 'Clarity', 10],
];

/** Tiny DOM builder; children are strings (as text) or nodes. Never parses HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const listOf = (title, items) => (items?.length
  ? h('section', { className: 'fb-section' }, h('h4', {}, title), h('ul', { className: 'fb-list' }, items.map((i) => h('li', {}, i))))
  : null);

export function createFeedbackPanel({ isVisible, setBadge, onFirstResult }) {
  const st = {
    order: [],          // questionIds, oldest → newest
    byId: new Map(),    // questionId → record
    selectedId: null,
    unseen: 0,
  };

  const current = () => (st.selectedId ? st.byId.get(st.selectedId) : null);

  function renderScore(rec) {
    return h('div', { className: 'fb-score' },
      h('span', { className: 'fb-score-value' }, String(rec.score)),
      h('span', { className: 'fb-score-max' }, '/ 100'));
  }

  function renderBreakdown(rec) {
    if (!rec.breakdown) return null;
    const rows = DIMENSIONS
      .filter(([key]) => typeof rec.breakdown[key] === 'number')
      .map(([key, label, weight]) => h('div', { className: 'fb-dim' },
        h('span', { className: 'fb-dim-label' }, label),
        h('span', { className: 'fb-bar' }, h('span', { className: 'fb-bar-fill', style: `width:${Math.max(0, Math.min(100, rec.breakdown[key]))}%` })),
        h('span', { className: 'fb-dim-value' }, `${rec.breakdown[key]}`),
        h('span', { className: 'fb-dim-weight' }, `${weight}%`)));
    return rows.length ? h('section', { className: 'fb-section' }, h('h4', {}, 'Breakdown'), ...rows) : null;
  }

  function render() {
    const box = $('feedbackBody');
    if (!box) return;
    box.textContent = '';

    const rec = current();
    if (!rec) {
      box.append(h('p', { className: 'chat-empty' },
        'Answer feedback will appear after you complete an interview answer.'));
      return;
    }

    box.append(h('section', { className: 'fb-card' },
      h('div', { className: 'fb-q-label' }, 'Question'),
      h('p', { className: 'fb-q' }, rec.questionText || '—')));

    if (rec.state === 'evaluating') {
      box.append(h('div', { className: 'fb-status' },
        h('span', { className: 'spinner', 'aria-hidden': 'true' }), ' Evaluating your answer…'));
    } else if (rec.state === 'error') {
      box.append(h('div', { className: 'fb-status error' }, rec.message || 'Answer evaluation unavailable.'));
    } else {
      box.append(
        h('section', { className: 'fb-card' },
          h('div', { className: 'fb-q-label' }, 'Your answer'),
          h('p', { className: 'fb-answer' }, rec.answer || '—')),
        h('section', { className: 'fb-card fb-overall' }, h('div', { className: 'fb-q-label' }, 'Overall'), renderScore(rec)),
        renderBreakdown(rec),
        listOf('Strengths', rec.strengths),
        listOf('Improvements', rec.improvements),
        listOf('Points you missed', rec.missingConcepts),
        rec.followUpQuestion
          ? h('section', { className: 'fb-section' }, h('h4', {}, 'Likely follow-up'), h('p', { className: 'fb-line' }, rec.followUpQuestion))
          : null,
      );
    }

    if (st.order.length > 1) {
      box.append(h('section', { className: 'fb-history' },
        h('h4', {}, 'Your answers'),
        h('ol', {}, st.order.map((id, i) => {
          const r = st.byId.get(id);
          const ready = r.state === 'ready';
          return h('li', {},
            h('button', {
              className: `linkish${id === st.selectedId ? ' on' : ''}`,
              onclick: () => { st.selectedId = id; render(); },
            }, `Q${i + 1} · ${(r.questionText || '').slice(0, 44)}`),
            h('span', { className: 'fb-flag' }, ready ? '✓ feedback' : r.state === 'error' ? '— unavailable' : '… evaluating'));
        }))));
    }
  }

  return {
    get hasAny() {
      return st.order.length > 0;
    },

    clearUnseen() {
      st.unseen = 0;
      setBadge(0);
    },

    /** Returns true when the message was handled here. */
    onMessage(msg) {
      if (msg.type !== 'answer_evaluation') return false;

      const first = st.order.length === 0;
      // Keyed by questionId: a later evaluation never overwrites an earlier one.
      const prev = st.byId.get(msg.questionId) || {};
      st.byId.set(msg.questionId, { ...prev, ...msg });
      if (!st.order.includes(msg.questionId)) st.order.push(msg.questionId);
      st.selectedId = msg.questionId;

      if (first) onFirstResult();
      if (msg.state === 'ready' || msg.state === 'error') {
        if (isVisible()) st.unseen = 0; else st.unseen++;
        setBadge(st.unseen);
      }
      render();
      return true;
    },

    getState() {
      return {
        order: st.order.slice(),
        entries: st.order.map((id) => ({ ...st.byId.get(id) })),
        selectedId: st.selectedId,
      };
    },

    render,
  };
}
