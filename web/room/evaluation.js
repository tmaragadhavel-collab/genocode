// Interviewer-only: question tracking, planned questions, private notes, live
// answer transcript and AI evaluation. The server never sends any of this data
// to candidates; this module is only initialised for the interviewer role.
// (Audio capture for transcription lives in stt.js and runs for both roles.)

const $ = (id) => document.getElementById(id);

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

function list(items, cls) {
  return items?.length ? h('ul', { className: `clist ${cls}` }, items.map((i) => h('li', {}, i))) : null;
}

export function createEvaluationPanel({ sendWS, toast, isVisible, setBadge }) {
  const st = {
    questions: [],
    planned: [],
    currentId: null,
    selectedId: null,
    partial: { interviewer: '', candidate: '' },
    lastHeard: '',
    dismissed: new Set(),
    evaluator: 'llm',
    transcription: 'unavailable',
    transcriptionOk: true,
    live: false,
    settings: { autoEndOnSilence: false, silenceSeconds: 5 },
    boundary: null, // { kind: 'silence' | 'newq', questionId, text? }
    unseen: 0,
  };
  let showEval = () => {};

  const byId = (id) => st.questions.find((q) => q.questionId === id);
  const upsert = (q) => {
    const i = st.questions.findIndex((x) => x.questionId === q.questionId);
    if (i >= 0) st.questions[i] = q; else st.questions.push(q);
  };
  // Re-rendering must not wipe what the interviewer is typing.
  const editingIn = (id) => !!document.activeElement?.closest?.(`#${id}`)
    && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);

  // ------------------------------------------------------------------ render

  function render() {
    $('evalMode').textContent = 'Demo scoring — not AI';
    $('evalMode').className = 'mode-badge demo';
    $('evalMode').hidden = st.evaluator !== 'demo-heuristic';
    if (!editingIn('questionBox')) renderQuestionBox();
    if (!editingIn('evalDetail')) renderDetail();
    renderBoundary();
    renderFollowUp();
    renderHistory();
    renderPlanned();
  }

  // Answer-boundary suggestions. The interviewer always decides.
  function renderBoundary() {
    const box = $('boundaryBox');
    const b = st.boundary;
    if (!b || b.questionId !== st.currentId) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const dismiss = () => { st.boundary = null; renderBoundary(); };
    if (b.kind === 'silence') {
      box.replaceChildren(
        h('h3', {}, 'Answer boundary'),
        h('div', { className: 'qtext' }, 'Candidate seems done. End answer and evaluate?'),
        h('div', { className: 'btn-row' },
          h('button', { className: 'host-btn primary', type: 'button', onclick: () => { dismiss(); sendWS({ type: 'question_end' }); } }, 'End & Evaluate'),
          h('button', { className: 'host-btn', type: 'button', onclick: dismiss }, 'Keep listening')));
    } else {
      box.replaceChildren(
        h('h3', {}, 'New question detected'),
        h('div', { className: 'qtext' }, `“${b.text}”`),
        h('div', { className: 'score-sub' }, 'You seem to have asked a new question while the previous answer is still open.'),
        h('div', { className: 'btn-row' },
          h('button', { className: 'host-btn primary', type: 'button', onclick: () => { dismiss(); sendWS({ type: 'question_start', questionText: b.text }); } }, 'End previous & start this question'),
          h('button', { className: 'host-btn', type: 'button', onclick: dismiss }, 'Dismiss')));
    }
  }

  function autoEndControl() {
    const s = st.settings;
    return h('div', { className: 'setting-row' },
      h('label', { className: 'setting-row' },
        h('input', { type: 'checkbox', checked: s.autoEndOnSilence ? true : null, onchange: (e) => sendWS({ type: 'interview_settings', autoEndOnSilence: e.target.checked }) }),
        'Auto-end answer after'),
      h('select', { 'aria-label': 'Silence before ending the answer', onchange: (e) => sendWS({ type: 'interview_settings', silenceSeconds: Number(e.target.value) }) },
        [3, 5, 8, 10, 15].map((n) => h('option', { value: String(n), selected: s.silenceSeconds === n ? true : null }, `${n}s`))),
      h('span', {}, s.autoEndOnSilence ? 'of silence (on)' : 'of silence (off — you will be asked)'));
  }

  function renderQuestionBox() {
    const box = $('questionBox');
    const current = byId(st.currentId);
    box.replaceChildren();

    if (current) {
      const answerBox = h('div', { className: 'answer-box', 'aria-live': 'polite' },
        current.answer || (st.partial.candidate ? '' : h('span', { className: 'muted' }, 'Waiting for the candidate to answer…')),
        st.partial.candidate ? h('span', { className: 'partial' }, `${current.answer ? ' ' : ''}${st.partial.candidate}…`) : null);
      const manual = h('details', {},
        h('summary', {}, 'Add answer text manually'),
        h('textarea', { id: 'manualAnswer', rows: '3', maxlength: '2000', placeholder: 'Paste or type what the candidate said' }),
        h('div', { className: 'btn-row' }, h('button', { className: 'host-btn', type: 'button', onclick: () => {
          const text = $('manualAnswer').value.trim();
          if (text && sendWS({ type: 'transcript_final', speaker: 'candidate', text })) $('manualAnswer').value = '';
        } }, 'Add to answer')));
      box.append(
        h('h3', {}, `Question ${current.index} · in progress`),
        h('div', { className: 'qtext' }, current.questionText),
        current.expectedConcepts?.length
          ? h('div', { className: 'score-sub' }, `Rubric (${current.rubricSource === 'ai' ? 'AI-generated' : 'yours'}): ${current.expectedConcepts.join(', ')}`)
          : h('div', { className: 'score-sub' }, st.evaluator === 'llm'
            ? 'No rubric given: the AI will derive the key concepts.'
            : 'No expected concepts given: demo scoring will be approximate.'),
        h('h3', {}, 'Candidate answer'),
        current.lowConfidence ? h('div', { className: 'eval-warn', role: 'note' }, '⚠ Contains low-confidence transcription — check before relying on the score.') : null,
        answerBox,
        manual,
        h('div', { className: 'btn-row' },
          h('button', { className: 'host-btn primary', type: 'button', disabled: !st.live, onclick: () => sendWS({ type: 'question_end' }) }, 'End question & evaluate')),
        autoEndControl(),
      );
      answerBox.scrollTop = answerBox.scrollHeight;
      return;
    }

    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const text = $('qText').value.trim();
      const concepts = $('qConcepts').value.split(',').map((c) => c.trim()).filter(Boolean);
      if (sendWS({ type: 'question_start', questionText: text, expectedConcepts: concepts, difficulty: $('qDifficulty').value })) {
        $('qText').value = '';
        $('qConcepts').value = '';
      }
    } },
      h('h3', {}, 'Next question'),
      st.live ? null : h('div', { className: 'eval-warn' }, 'Start or resume the interview to ask questions.'),
      h('textarea', { id: 'qText', rows: '2', maxlength: '1000', placeholder: 'Type the question, or leave empty to use what you just asked aloud', 'aria-label': 'Question text' }),
      st.lastHeard ? h('div', { className: 'heard' }, `Last heard from you: “${st.lastHeard}”`) : null,
      h('details', {},
        h('summary', {}, st.evaluator === 'llm' ? 'Rubric (optional — AI prepares one if empty)' : 'Rubric (demo scoring needs expected concepts)'),
        h('input', { id: 'qConcepts', maxlength: '600', placeholder: 'Expected concepts, comma-separated', 'aria-label': 'Expected concepts' }),
        h('div', { className: 'row' },
          h('select', { id: 'qDifficulty', 'aria-label': 'Difficulty' },
            h('option', { value: 'easy' }, 'Easy'), h('option', { value: 'medium', selected: true }, 'Medium'), h('option', { value: 'hard' }, 'Hard')))),
      h('div', { className: 'btn-row' },
        h('button', { className: 'host-btn primary', type: 'submit', disabled: !st.live }, 'Start question'),
        st.planned.some((p) => !p.askedQuestionId) ? h('span', { className: 'score-sub' }, 'or pick a planned question in the Questions tab') : null),
      h('div', { className: 'score-sub' },
        st.transcription === 'unavailable'
          ? 'Speech-to-text is not configured; add answers manually.'
          : st.transcriptionOk
            ? 'Live transcription is on for both participants while the interview is live.'
            : 'Transcription unavailable right now — you can add answers manually.'),
    );
    box.append(form);
  }

  function renderFollowUp() {
    const box = $('followUpBox');
    const latest = [...st.questions].reverse().find((q) => q.status === 'completed' && q.evaluation?.followUpQuestion);
    const show = latest && st.live && !st.dismissed.has(latest.questionId) && !st.currentId
      && (latest.finalScore < 80 || latest.evaluation.missingConcepts.length);
    box.hidden = !show;
    if (!show) return;
    const text = latest.evaluation.followUpQuestion;
    box.replaceChildren(
      h('h3', {}, `${latest.evaluation.evaluator === 'llm' ? 'AI follow-up' : 'Suggested follow-up (demo)'} · after Q${latest.index} (${latest.finalScore}/100)`),
      h('div', { className: 'qtext' }, text),
      h('div', { className: 'btn-row' },
        h('button', { className: 'host-btn primary', type: 'button', onclick: () => {
          st.dismissed.add(latest.questionId);
          sendWS({ type: 'question_start', questionText: text });
        } }, 'Ask question'),
        h('button', { className: 'host-btn', type: 'button', onclick: () => { st.dismissed.add(latest.questionId); render(); } }, 'Dismiss')),
      h('div', { className: 'score-sub' }, 'Suggestion only — nothing is sent to the candidate unless you ask it.'),
    );
  }

  function renderDetail() {
    const box = $('evalDetail');
    const q = byId(st.selectedId) || [...st.questions].reverse().find((x) => x.status !== 'not_started' && x.status !== 'answering');
    box.hidden = !q;
    if (!q) return;
    const e = q.evaluation;
    const parts = [h('h3', {}, `Question ${q.index}`), h('div', { className: 'qtext' }, q.questionText)];

    if (q.status === 'evaluating') {
      parts.push(h('div', { className: 'evaluating', role: 'status' }, h('span', { className: 'spinner' }), 'AI evaluating…'));
    } else if (q.status === 'error') {
      parts.push(h('div', { className: 'eval-err', role: 'alert' }, q.evaluationError || 'AI evaluation temporarily unavailable.'),
        h('div', { className: 'btn-row' }, h('button', { className: 'host-btn', type: 'button', onclick: () => sendWS({ type: 'evaluation_retry', questionId: q.questionId }) }, 'Retry evaluation')),
        h('div', { className: 'score-sub' }, 'The interview continues normally.'));
    } else if (q.status === 'no_answer') {
      parts.push(h('div', { className: 'score-sub' }, 'No answer was captured for this question, so it was not scored.'));
    } else if (q.status === 'answering' || q.status === 'not_started') {
      parts.push(h('div', { className: 'score-sub' }, 'In progress.'));
    }

    if (e) {
      const overridden = q.override;
      parts.push(
        h('div', { className: 'score-big' }, String(q.finalScore), h('small', {}, ' / 100')),
        q.lowConfidence ? h('div', { className: 'eval-warn', role: 'note' }, '⚠ Answer includes low-confidence transcription') : null,
        overridden
          ? h('div', { className: 'score-sub' }, `AI Score: ${overridden.aiScore} · Interviewer Score: ${overridden.finalScore} — “${overridden.overrideReason}” (${overridden.overriddenBy})`)
          : h('div', { className: 'score-sub' }, `${e.evaluator === 'demo-heuristic' ? 'Demo keyword scoring (no AI key) — not an AI judgement' : `AI-generated score · ${e.model}`} · confidence ${Math.round(e.confidence * 100)}%`),
        h('div', { className: 'bars' }, DIMENSIONS.map(([key, label, weight]) =>
          h('div', { className: 'bar-row' },
            h('span', {}, label, h('span', { className: 'w' }, `${weight}%`)),
            h('div', { className: 'track' }, h('div', { className: 'fill', style: `width:${e.breakdown[key]}%` })),
            h('span', { className: 'v' }, String(e.breakdown[key]))))),
        e.coveredConcepts.length ? h('h3', {}, 'Covered') : null, list(e.coveredConcepts, 'ok'),
        e.missingConcepts.length ? h('h3', {}, 'Missing') : null, list(e.missingConcepts, 'miss'),
        e.factualErrors?.length ? h('h3', {}, 'Factual errors') : null, list(e.factualErrors, 'err'),
        e.strengths.length ? h('h3', {}, 'Strengths') : null, list(e.strengths, 'plain'),
        e.improvements.length ? h('h3', {}, 'Improvements') : null, list(e.improvements, 'plain'),
        overrideForm(q),
      );
    }
    if (q.answer || q.editedAnswer) parts.push(answerEditor(q));
    if (q.evaluationHistory?.length > 1) parts.push(historyView(q));
    parts.push(questionNote(q));
    box.replaceChildren(...parts.filter(Boolean)); // replaceChildren would print null as text
  }

  // Transcript correction: the original STT text is always kept.
  function answerEditor(q) {
    const open = q.questionId === st.currentId;
    const current = q.editedAnswer ?? q.answer;
    const busy = q.status === 'evaluating';
    return h('details', {},
      h('summary', {}, q.editedAnswer !== null ? 'Candidate answer (edited)' : 'Candidate answer (transcript)'),
      h('textarea', { id: `ans-${q.questionId}`, rows: '5', maxlength: '8000', 'aria-label': 'Candidate answer text', disabled: open ? true : null }, current),
      q.editedAnswer !== null
        ? h('div', { className: 'score-sub' }, `Edited by ${q.editedBy} · ${new Date(q.editedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Original transcript is kept.`)
        : null,
      q.editedAnswer !== null ? h('details', {}, h('summary', {}, 'Original transcript'), h('div', { className: 'answer-box' }, q.answer)) : null,
      h('div', { className: 'btn-row' },
        h('button', { className: 'host-btn', type: 'button', disabled: open ? true : null, onclick: () => {
          const text = $(`ans-${q.questionId}`).value.trim();
          if (text && text !== current) sendWS({ type: 'answer_edit', questionId: q.questionId, text });
        } }, 'Save correction'),
        q.editedAnswer !== null
          ? h('button', { className: 'host-btn', type: 'button', onclick: () => sendWS({ type: 'answer_edit', questionId: q.questionId, text: null }) }, 'Revert to original')
          : null,
        h('button', { className: 'host-btn primary', type: 'button', disabled: open || busy ? true : null,
          title: open ? 'End the question first' : busy ? 'An evaluation is running' : 'Run a new evaluation on this text',
          onclick: () => sendWS({ type: 'evaluation_reevaluate', questionId: q.questionId }) }, 'Re-evaluate')));
  }

  function historyView(q) {
    return h('details', {},
      h('summary', {}, `Evaluation history (${q.evaluationHistory.length} runs)`),
      h('ol', { className: 'clist plain' }, [...q.evaluationHistory].reverse().map((e, i) => h('li', {},
        `${e.score}/100 · ${new Date(e.evaluatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · `
        + `${e.trigger === 'reevaluate' ? 're-evaluated' : e.trigger === 'retry' ? 'retried' : 'automatic'} on ${e.answerSource} text`
        + (i === 0 ? ' (current)' : '')))));
  }

  function questionNote(q) {
    const status = h('span', { className: 'score-sub', id: `qNoteStatus-${q.questionId}` });
    return h('details', { open: q.interviewerNote ? true : null },
      h('summary', {}, 'Private note for this question'),
      h('textarea', { id: `qNote-${q.questionId}`, rows: '2', maxlength: '4000', placeholder: 'Only you can see this' }, q.interviewerNote || ''),
      h('div', { className: 'btn-row' },
        h('button', { className: 'host-btn', type: 'button', onclick: () => {
          status.textContent = sendWS({ type: 'note_save', questionId: q.questionId, text: $(`qNote-${q.questionId}`).value })
            ? 'Saving…' : 'Not connected — try again.';
        } }, 'Save note'), status));
  }

  function overrideForm(q) {
    return h('details', {},
      h('summary', {}, q.override ? 'Change interviewer score' : 'Override score'),
      h('div', { className: 'row' },
        h('input', { id: `ovScore-${q.questionId}`, type: 'number', min: '0', max: '100', value: String(q.finalScore), 'aria-label': 'Interviewer score' })),
      h('input', { id: `ovReason-${q.questionId}`, maxlength: '500', placeholder: 'Reason (required)', value: q.override?.overrideReason || '', 'aria-label': 'Override reason' }),
      h('div', { className: 'btn-row' },
        h('button', { className: 'host-btn primary', type: 'button', onclick: () => sendWS({
          type: 'evaluation_override',
          questionId: q.questionId,
          score: Number($(`ovScore-${q.questionId}`).value),
          reason: $(`ovReason-${q.questionId}`).value,
        }) }, 'Save score'),
        q.override ? h('button', { className: 'host-btn', type: 'button', onclick: () => sendWS({ type: 'evaluation_override', questionId: q.questionId, score: null }) }, 'Use AI score') : null));
  }

  function renderHistory() {
    const ol = $('historyList');
    if (!st.questions.length) {
      ol.replaceChildren(h('li', { className: 'muted small' }, 'No questions yet.'));
      return;
    }
    ol.replaceChildren(...st.questions.map((q) => {
      const label = {
        completed: `${q.finalScore}/100${q.override ? '*' : ''}`,
        evaluating: 'Evaluating',
        error: 'Unavailable',
        no_answer: 'No answer',
        answering: 'Answering',
        not_started: 'Asked',
      }[q.status];
      return h('li', {}, h('button', {
        type: 'button',
        className: st.selectedId === q.questionId ? 'selected' : '',
        'aria-label': `Question ${q.index}: ${q.questionText}. ${label}. Open evaluation`,
        onclick: () => { st.selectedId = q.questionId; renderDetail(); renderHistory(); showEval(); },
      },
      h('span', { className: 'qn' }, `Q${q.index}`),
      h('span', { className: 'qt' }, q.questionText),
      h('span', { className: `qs${q.status === 'completed' ? '' : ' pending'}` }, `${q.lowConfidence && q.status === 'completed' ? '⚠ ' : ''}${label}`)));
    }));
  }

  function renderPlanned() {
    const box = $('plannedBox');
    if (!st.planned.length) {
      box.replaceChildren(h('h3', {}, 'Planned questions'), h('div', { className: 'score-sub' }, 'No planned questions. Type questions in the AI Evaluation tab.'));
      return;
    }
    box.replaceChildren(
      h('h3', {}, 'Planned questions'),
      h('div', { className: 'planned' }, st.planned.map((p) => h('div', { className: `planned-item${p.askedQuestionId ? ' asked' : ''}` },
        h('div', {}, h('div', {}, p.text),
          h('div', { className: 'meta' }, [p.difficulty, p.skills.join(', '), p.expectedConcepts.length ? `${p.expectedConcepts.length} expected concepts` : ''].filter(Boolean).join(' · '))),
        p.askedQuestionId
          ? h('span', { className: 'score-sub' }, 'Asked')
          : h('button', { className: 'host-btn primary', type: 'button', disabled: !st.live || !!st.currentId,
            title: !st.live ? 'Start the interview first' : st.currentId ? 'End the current question first' : 'Ask this question now',
            onclick: () => { sendWS({ type: 'question_start', plannedQuestionId: p.id }); showEval(); } }, 'Ask')))));
  }

  // ------------------------------------------------------------------ private general notes (autosave)

  let noteTimer = null;
  $('generalNotes').addEventListener('input', () => {
    $('notesStatus').textContent = 'Saving…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (!sendWS({ type: 'note_save', text: $('generalNotes').value })) {
        $('notesStatus').textContent = 'Not connected — type again once reconnected to save.';
      }
    }, 700);
  });

  // ------------------------------------------------------------------ server events

  function notify(q) {
    if (isVisible()) return;
    st.unseen++;
    setBadge(st.unseen);
    if (q.status === 'completed') toast(`Q${q.index} evaluated: ${q.finalScore}/100`);
    if (q.status === 'error') toast(`Q${q.index}: AI evaluation temporarily unavailable.`);
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'question_started': {
        upsert(msg.question);
        st.currentId = msg.question.questionId;
        st.partial.candidate = '';
        const planned = st.planned.find((p) => p.id === msg.plannedQuestionId);
        if (planned) planned.askedQuestionId = msg.question.questionId;
        break;
      }
      case 'question_updated':
      case 'evaluation_updated':
        upsert(msg.question);
        break;
      case 'answer_started': {
        const q = byId(msg.questionId);
        if (q) q.status = 'answering';
        break;
      }
      case 'answer_completed': {
        const q = byId(msg.questionId);
        if (q) { q.status = msg.hasAnswer ? 'evaluating' : 'no_answer'; q.answeredAt = Date.now(); }
        if (st.currentId === msg.questionId) st.currentId = null;
        st.selectedId = msg.questionId;
        st.partial.candidate = '';
        break;
      }
      case 'transcript_partial':
        st.partial[msg.speaker] = msg.text;
        if (msg.speaker === 'interviewer') return true; // nothing visible changes
        break;
      case 'transcript_final': {
        st.partial[msg.speaker] = '';
        if (msg.speaker === 'interviewer') st.lastHeard = msg.text.slice(-160);
        const q = msg.questionId && byId(msg.questionId);
        if (q && msg.speaker === 'candidate') q.answer = `${q.answer} ${msg.text}`.trim();
        break;
      }
      case 'evaluation_started': {
        const q = byId(msg.questionId);
        if (q) q.status = 'evaluating';
        break;
      }
      case 'evaluation_completed':
        upsert(msg.question);
        notify(msg.question);
        break;
      case 'evaluation_error': {
        const q = byId(msg.questionId);
        if (q) { q.status = 'error'; q.evaluationError = msg.message; notify(q); }
        break;
      }
      case 'settings_updated':
        st.settings = msg.settings;
        break;
      case 'answer_silence_prompt':
        st.boundary = { kind: 'silence', questionId: msg.questionId };
        if (!isVisible()) toast('Candidate seems done.', '', { label: 'End & Evaluate', run: () => sendWS({ type: 'question_end' }) });
        break;
      case 'new_question_detected':
        st.boundary = { kind: 'newq', questionId: msg.openQuestionId, text: msg.text };
        if (!isVisible()) toast('New question detected — end the previous answer?', '', { label: 'End & start', run: () => sendWS({ type: 'question_start', questionText: msg.text }) });
        break;
      case 'answer_auto_ended':
        toast(msg.reason === 'silence' ? 'Answer ended after silence (auto-end is on)' : 'Previous answer ended: new question asked');
        break;
      case 'notes_updated': {
        if (msg.questionId === null) {
          $('notesStatus').textContent = 'Saved.';
          if (document.activeElement !== $('generalNotes')) $('generalNotes').value = msg.text;
          return true;
        }
        const q = byId(msg.questionId);
        if (q) q.interviewerNote = msg.text;
        const status = $(`qNoteStatus-${msg.questionId}`);
        if (status) status.textContent = 'Saved.';
        return true;
      }
      default:
        return false;
    }
    render();
    return true;
  }

  function onJoined(msg) {
    st.questions = msg.questions || [];
    st.planned = msg.plannedQuestions || [];
    st.settings = msg.settings || st.settings;
    st.currentId = msg.currentQuestionId || null;
    st.evaluator = msg.evaluator || 'llm';
    st.transcription = msg.transcription || 'unavailable';
    st.transcriptionOk = msg.transcriptionStatus !== 'unavailable';
    const lastMine = (msg.transcript || []).filter((s) => s.speaker === 'interviewer').at(-1);
    st.lastHeard = lastMine ? lastMine.text.slice(-160) : '';
    if (document.activeElement !== $('generalNotes')) $('generalNotes').value = msg.generalNotes || '';
    render();
  }

  function setActive(isLive) {
    if (st.live === isLive) return;
    st.live = isLive;
    render();
  }

  function setTranscriptionOk(ok) {
    st.transcriptionOk = ok;
    if (!editingIn('questionBox')) renderQuestionBox();
  }

  function clearUnseen() {
    st.unseen = 0;
    setBadge(0);
  }

  render();
  return {
    onMessage,
    onJoined,
    setActive,
    setTranscriptionOk,
    clearUnseen,
    onShowEval: (fn) => { showEval = fn; },
  };
}
