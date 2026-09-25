// Candidate-only: live AI coaching for the question the interviewer just asked.
//
// This panel is only initialised for the candidate, and only when the interview
// was created with coaching enabled. The interviewer is told that coaching is
// on (a badge in their top bar) but never receives its content — that split is
// enforced on the server, not here.
//
// Hints, not answers: the panel deliberately renders short bullets and refuses
// to grow into a script the candidate would read aloud.

const $ = (id) => document.getElementById(id);

const SECTIONS = [
  ['HINTS', 'Key points'],
  ['STRUCTURE', 'Structure'],
  ['GROUNDING', 'Draw on'],
  ['CAUTION', 'Watch out'],
];

const STATE_LABEL = {
  thinking: 'Thinking…',
  streaming: 'Writing hints…',
  complete: '',
  error: 'AI coaching temporarily unavailable',
};

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

/** "- one\n- two" → ['one', 'two']; plain text stays one line. */
function bullets(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean);
}

export function createCoachPanel({ isVisible, setBadge }) {
  const st = {
    enabled: false,
    available: true,
    history: [], // oldest → newest
    selectedId: null,
    unseen: 0,
  };

  const current = () => st.history.find((r) => r.questionId === st.selectedId) ?? st.history[st.history.length - 1] ?? null;
  const byId = (id) => st.history.find((r) => r.questionId === id);

  function blank() {
    return { HINTS: '', STRUCTURE: '', GROUNDING: '', CAUTION: '' };
  }

  function renderSection(key, label, value) {
    const items = bullets(value);
    if (!items.length) return null;
    return h('section', { className: 'coach-section' },
      h('h4', {}, label),
      key === 'HINTS'
        ? h('ul', { className: 'coach-hints' }, items.map((i) => h('li', {}, i)))
        : h('p', { className: 'coach-line' }, items.join(' ')));
  }

  function render() {
    const box = $('coachBody');
    if (!box) return;
    box.textContent = '';

    if (!st.enabled) {
      box.append(h('p', { className: 'chat-empty' },
        'AI coaching is not enabled for this interview.'));
      return;
    }

    const rec = current();
    if (!rec) {
      box.append(h('p', { className: 'chat-empty' },
        'When the interviewer asks a question, short hints will appear here. '
        + 'Your interviewer knows this assistance is switched on.'));
      return;
    }

    const status = STATE_LABEL[rec.state] || '';
    box.append(
      h('section', { className: 'coach-card' },
        h('div', { className: 'coach-q-label' }, 'Question'),
        h('p', { className: 'coach-q' }, rec.question),
        status ? h('div', { className: `coach-status${rec.state === 'error' ? ' error' : ''}` },
          rec.state === 'thinking' || rec.state === 'streaming'
            ? [h('span', { className: 'spinner', 'aria-hidden': 'true' }), ' ', status]
            : status) : null,
      ),
      ...SECTIONS.map(([k, label]) => renderSection(k, label, rec.sections[k])).filter(Boolean),
    );

    if (st.history.length > 1) {
      box.append(h('section', { className: 'coach-history' },
        h('h4', {}, 'Earlier questions'),
        h('ol', {},
          st.history.slice(0, -1).reverse().map((r) => h('li', {},
            h('button', {
              className: `linkish${r.questionId === st.selectedId ? ' on' : ''}`,
              onclick: () => { st.selectedId = r.questionId; render(); },
            }, r.question))))));
    }
  }

  function bump() {
    if (isVisible()) {
      st.unseen = 0;
    } else {
      st.unseen++;
    }
    setBadge(st.unseen);
  }

  return {
    get enabled() {
      return st.enabled;
    },

    clearUnseen() {
      st.unseen = 0;
      setBadge(0);
    },

    onJoined(msg) {
      st.enabled = msg.coachingEnabled === true;
      st.available = msg.coachingAvailable !== false;
      st.history = Array.isArray(msg.coachingHistory) ? msg.coachingHistory.slice() : [];
      st.selectedId = st.history.length ? st.history[st.history.length - 1].questionId : null;
      render();
    },

    /** Returns true when the message was a coaching message and is fully handled. */
    onMessage(msg) {
      switch (msg.type) {
        case 'coaching_question': {
          st.history.push({
            questionId: msg.questionId,
            question: msg.question,
            detectedAt: Date.now(),
            state: 'thinking',
            sections: blank(),
            error: null,
          });
          if (st.history.length > 20) st.history.shift();
          st.selectedId = msg.questionId; // a new question always takes focus
          render();
          bump();
          return true;
        }
        case 'coaching_delta': {
          const rec = byId(msg.questionId);
          if (!rec) return true;
          rec.sections[msg.section] = (rec.sections[msg.section] || '') + msg.text;
          if (rec.questionId === st.selectedId) render();
          return true;
        }
        case 'coaching_state': {
          const rec = byId(msg.questionId);
          if (!rec) return true;
          rec.state = msg.state;
          rec.error = msg.error ?? null;
          if (rec.questionId === st.selectedId) render();
          return true;
        }
        // The interviewer's copy; a candidate should never see it.
        case 'coaching_activity':
          return true;
        default:
          return false;
      }
    },

    getState() {
      return { history: st.history.slice(), selectedId: st.selectedId, enabled: st.enabled };
    },

    render,
  };
}
