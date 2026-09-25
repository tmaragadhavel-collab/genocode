// Final interview report. Numbers come from stored evaluations; the AI summary,
// strengths and gaps are labelled AI-generated; decision and final score are human-only.

const sessionId = location.pathname.split('/')[2];
const app = document.getElementById('app');
const DIMENSIONS = [['correctness', 'Correctness', 40], ['completeness', 'Completeness', 25], ['relevance', 'Relevance', 15], ['technicalDepth', 'Technical depth', 10], ['clarity', 'Clarity', 10]];
const DECISIONS = [['undecided', 'Undecided'], ['strong_hire', 'Strong hire'], ['hire', 'Hire'], ['no_hire', 'No hire'], ['strong_no_hire', 'Strong no hire']];
let data = null;
let pollTimer = null;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const list = (items, cls) => (items?.length ? h('ul', { className: `clist ${cls}` }, items.map((i) => h('li', {}, i))) : h('p', { className: 'muted small' }, 'None recorded.'));
const bar = (v) => h('div', { className: 'bar', role: 'img', 'aria-label': `${v} out of 100` }, h('span', { style: `width:${Math.max(0, Math.min(100, v))}%` }));
const fmtDate = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' }) : '—');

function state(text, { spinner = false, action = null } = {}) {
  app.replaceChildren(h('div', { className: 'center-state' }, spinner ? h('span', { className: 'spinner' }) : null, h('p', {}, text), action));
}

async function load() {
  clearTimeout(pollTimer);
  let resp;
  try {
    resp = await fetch(`/api/interviews/${encodeURIComponent(sessionId)}/report`);
  } catch {
    state('Could not reach the server.', { action: h('button', { className: 'btn primary', onclick: load }, 'Try again') });
    return;
  }
  if (resp.status === 401) { location.replace(`/login?next=${encodeURIComponent(location.pathname)}`); return; }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    state(body.error || 'Could not load the report.', { action: h('a', { className: 'btn primary', href: '/dashboard' }, 'Back to interviews') });
    return;
  }
  data = body;
  if (data.reportStatus === 'generating' || (data.reportStatus === 'none' && data.status === 'COMPLETED')) {
    state('Generating interview report…', { spinner: true });
    pollTimer = setTimeout(load, 2000);
    return;
  }
  if (data.status !== 'COMPLETED' && data.status !== 'CANCELLED') {
    state('The report is available after the interview ends.', { action: h('a', { className: 'btn primary', href: `/interview/${sessionId}/interviewer` }, 'Go to interview room') });
    return;
  }
  if (data.reportStatus === 'failed' || !data.report) {
    state('Report generation failed. Your interview data is saved.', { action: h('button', { className: 'btn primary', onclick: regenerate }, 'Retry report generation') });
    return;
  }
  render();
}

async function regenerate() {
  state('Generating interview report…', { spinner: true });
  await fetch(`/api/interviews/${encodeURIComponent(sessionId)}/report`, { method: 'POST' }).catch(() => {});
  setTimeout(load, 1200);
}

async function put(url, payload, statusEl) {
  statusEl.textContent = 'Saving…';
  try {
    const resp = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || 'Could not save.');
    statusEl.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    return body;
  } catch (err) {
    statusEl.textContent = err.message === 'Failed to fetch' ? 'Could not reach the server. Try again.' : err.message;
    return null;
  }
}

function render() {
  const r = data.report;
  const d = data.details;
  const demo = r.evaluator === 'demo-heuristic';
  const aiTag = demo ? h('span', { className: 'ai-label demo' }, 'Demo scoring — not AI') : h('span', { className: 'ai-label' }, 'AI-generated evaluation');
  const qById = Object.fromEntries(data.questions.map((q) => [q.questionId, q]));

  // --- Hero ---
  const hero = h('section', { className: 'card hero' },
    h('div', { className: 'stack', style: 'gap:6px' },
      h('h3', {}, 'Interview report'),
      h('h1', {}, d.candidateName),
      h('p', { className: 'muted' }, `${d.position} · ${fmtDate(r.interviewDate)} · ${r.durationMinutes} of ${r.scheduledMinutes} minutes · Interviewer: ${d.interviewerName}`),
      data.status === 'CANCELLED' ? h('p', { className: 'notice warn' }, 'This interview was cancelled before it finished.') : null),
    h('div', { style: 'text-align:right' },
      h('div', { className: 'score-xl' }, r.averageFinalScore ?? '—', h('small', {}, ' / 100')),
      h('div', { className: 'small muted' }, r.averageFinalScore === r.averageAiScore ? 'Average AI score' : `Average score (AI ${r.averageAiScore}, with your overrides)`),
      h('div', { style: 'margin-top:6px' }, aiTag)));

  const stats = h('section', { className: 'stats' },
    [['Questions asked', r.questionsAsked], ['Answered', r.questionsAnswered], ['Evaluated', r.questionsEvaluated],
      ['Your final score', data.review.finalScore === null ? 'Not set' : `${data.review.finalScore}/100`]]
      .map(([k, v]) => h('div', { className: 'stat' }, h('div', { className: 'small muted' }, k), h('div', { className: 'v' }, v))));

  const disclaimer = h('p', { className: 'notice' },
    demo
      ? 'Scores were produced by the demo keyword scorer because no AI key is configured. They are a rough signal only.'
      : 'AI scores are generated from the interview transcript against each question\'s rubric. They can be wrong, especially if the transcript is inaccurate. Treat them as input to your judgement, not as objective truth.');

  // --- Question results (click for details) ---
  const tbody = h('tbody');
  for (const qr of r.questionResults) {
    const q = qById[qr.questionId];
    const score = qr.finalScore;
    const detailRow = h('tr', { className: 'qdetail', hidden: true }, h('td', { colspan: '5' }, questionDetail(q)));
    const row = h('tr', { className: 'qrow', tabindex: '0', 'aria-expanded': 'false',
      onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      h('td', { className: 'muted num' }, `Q${qr.index}`),
      h('td', {}, qr.questionText, qr.skills.length ? h('div', { className: 'small muted' }, qr.skills.join(', ')) : null),
      h('td', { style: 'width:30%' }, score === null ? null : bar(score)),
      h('td', { className: 'num', style: 'white-space:nowrap' },
        score === null ? h('span', { className: 'muted' }, { no_answer: 'No answer', error: 'Not evaluated', evaluating: 'Not evaluated' }[qr.status] || '—') : `${score}${qr.overridden ? '*' : ''}${q?.lowConfidence ? ' ⚠' : ''}`),
      h('td', { className: 'muted small' }, qr.overridden ? `AI ${qr.aiScore}` : ''));
    function toggle() {
      detailRow.hidden = !detailRow.hidden;
      row.setAttribute('aria-expanded', String(!detailRow.hidden));
    }
    tbody.append(row, detailRow);
  }
  const questions = h('section', { className: 'card stack' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' }, h('h2', {}, 'Question results'), aiTag.cloneNode(true)),
    r.questionResults.length
      ? h('div', { style: 'overflow-x:auto' }, h('table', { className: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Question'), h('th', {}, 'Score by question'), h('th', {}, 'Score'), h('th', {}, ''))), tbody))
      : h('p', { className: 'muted' }, 'No questions were asked.'),
    h('p', { className: 'small muted' }, '* adjusted by the interviewer · ⚠ answer includes low-confidence transcription. Click a question for the answer, breakdown, feedback and corrections.'));

  // --- Skills & AI findings ---
  const skills = h('section', { className: 'card stack' },
    h('h2', {}, 'Skill breakdown'),
    r.skillBreakdown.length
      ? h('div', { style: 'overflow-x:auto' }, h('table', { className: 'table' }, h('tbody', {}, r.skillBreakdown.map((s) => h('tr', {},
        h('td', {}, s.skill), h('td', { style: 'width:45%' }, bar(s.score)), h('td', { className: 'num' }, s.score),
        h('td', { className: 'small muted' }, `${s.questions} question${s.questions > 1 ? 's' : ''}`))))))
      : h('p', { className: 'muted' }, 'No evaluated questions.'),
    h('p', { className: 'small muted' }, 'Average of question scores tagged with each skill. Untagged questions count as "General".'));

  const findings = h('section', { className: 'grid-2' },
    h('div', { className: 'card stack' }, h('h2', {}, 'Technical strengths'), list(r.strengths, 'ok')),
    h('div', { className: 'card stack' }, h('h2', {}, 'Weaknesses'), list(r.weaknesses, 'err')),
    h('div', { className: 'card stack', style: 'grid-column:1/-1' }, h('h2', {}, 'Areas to explore'), list(r.areasToExplore, 'miss')));

  const summary = h('section', { className: 'card stack' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' }, h('h2', {}, 'AI summary'), h('span', { className: 'ai-label' }, 'AI-generated')),
    r.aiSummary
      ? h('p', { style: 'line-height:1.6' }, r.aiSummary)
      : h('p', { className: 'muted' }, r.aiSummaryStatus === 'demo'
        ? 'No AI summary: the server is running without an AI key.'
        : 'AI summary unavailable (the AI service could not be reached). Scores and findings above are unaffected.'),
    r.aiSummaryStatus === 'unavailable' && r.questionsEvaluated
      ? h('div', {}, h('button', { className: 'btn small', onclick: regenerate }, 'Retry AI summary')) : null);

  // --- Human review ---
  const saved = h('span', { className: 'saved' }, data.review.updatedAt ? `Last saved by ${data.review.updatedBy} · ${fmtDate(data.review.updatedAt)}` : '');
  const decision = h('select', { 'aria-label': 'Final decision' }, DECISIONS.map(([v, l]) => h('option', { value: v, selected: data.review.decision === v }, l)));
  const finalScore = h('input', { type: 'number', min: '0', max: '100', placeholder: 'e.g. 80', value: data.review.finalScore ?? '', 'aria-label': 'Final interviewer score' });
  const notes = h('textarea', { rows: '4', maxlength: '8000', placeholder: 'Final interviewer notes' }, data.review.notes);
  const comments = h('textarea', { rows: '3', maxlength: '8000', placeholder: 'Additional comments' }, data.review.comments);
  const review = h('section', { className: 'card stack' },
    h('div', {}, h('h2', {}, 'Your decision'), h('p', { className: 'small muted' }, 'Human-controlled. The AI never sets these fields.')),
    h('div', { className: 'grid-2' }, h('label', { className: 'field' }, 'Final decision', decision), h('label', { className: 'field' }, 'Final interviewer score (0–100)', finalScore)),
    h('label', { className: 'field' }, 'Final interviewer notes', notes),
    h('label', { className: 'field' }, 'Additional comments', comments),
    h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
      h('button', { className: 'btn primary', onclick: async () => {
        const score = finalScore.value === '' ? null : Number(finalScore.value);
        const body = await put(`/api/interviews/${sessionId}/review`, { decision: decision.value, finalScore: score, notes: notes.value, comments: comments.value }, saved);
        if (body) { data.review = body.review; saved.textContent = `Saved by ${body.review.updatedBy} · ${fmtDate(body.review.updatedAt)}`; }
      } }, 'Save decision'), saved));

  const generalStatus = h('span', { className: 'saved' });
  const general = h('textarea', { rows: '4', maxlength: '4000' }, data.generalNotes);
  const notesCard = h('section', { className: 'card stack' },
    h('div', {}, h('h2', {}, 'Interview notes'), h('p', { className: 'small muted' }, 'Private notes taken during the interview. Never shown to the candidate.')),
    general,
    h('div', { style: 'display:flex;gap:12px;align-items:center' },
      h('button', { className: 'btn', onclick: () => put(`/api/interviews/${sessionId}/notes`, { text: general.value }, generalStatus) }, 'Save notes'), generalStatus));

  const transcript = h('section', { className: 'card stack' },
    h('details', {}, h('summary', { style: 'cursor:pointer' }, h('strong', {}, `Transcript (${data.transcript.length} segments)`)),
      h('div', { className: 'transcript', style: 'margin-top:12px' },
        data.transcript.length ? data.transcript.map((s) => h('div', {},
          h('div', { className: 'who', style: `color:${s.speaker === 'interviewer' ? '#8fc1ff' : 'var(--accent)'}` },
            s.speaker === 'interviewer' ? d.interviewerName : d.candidateName, ' ',
            h('span', { className: 'muted small' }, new Date(s.timestamp).toLocaleTimeString())),
          h('div', {}, s.text))) : h('p', { className: 'muted' }, 'No transcript was captured.'))));

  app.replaceChildren(h('div', { className: 'stack' }, hero, stats, disclaimer, questions, skills, findings, summary, review, notesCard, transcript));
}

async function post(url, statusEl) {
  statusEl.textContent = 'Starting…';
  try {
    const resp = await fetch(url, { method: 'POST' });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || 'Could not start.');
    return true;
  } catch (err) {
    statusEl.textContent = err.message === 'Failed to fetch' ? 'Could not reach the server. Try again.' : err.message;
    return false;
  }
}

function questionDetail(q) {
  const e = q.evaluation;
  const base = `/api/interviews/${sessionId}/questions/${q.questionId}`;
  const answerStatus = h('span', { className: 'saved' });
  const answerBox = h('textarea', { rows: '4', maxlength: '8000', 'aria-label': 'Candidate answer text' }, q.editedAnswer ?? q.answer ?? '');
  const noteStatus = h('span', { className: 'saved' });
  const note = h('textarea', { rows: '2', maxlength: '4000', placeholder: 'Private note for this question' }, q.interviewerNote || '');
  return h('div', { className: 'detail' },
    h('div', { className: 'full' }, h('h3', {}, 'Question'), h('p', {}, q.questionText)),
    h('div', { className: 'full stack', style: 'gap:6px' },
      h('h3', {}, q.editedAnswer !== null ? 'Candidate answer (corrected by interviewer)' : 'Candidate answer (transcript)'),
      q.lowConfidence ? h('p', { className: 'notice warn' }, '⚠ This answer includes low-confidence speech recognition. Check the text before relying on the score.') : null,
      q.answer || q.editedAnswer ? answerBox : h('div', { className: 'answer' }, 'No answer captured.'),
      q.editedAnswer !== null ? h('details', {}, h('summary', { className: 'small muted' }, `Original transcript (edited by ${q.editedBy})`), h('div', { className: 'answer' }, q.answer)) : null,
      q.answer || q.editedAnswer ? h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        h('button', { className: 'btn small', onclick: async (ev) => {
          ev.stopPropagation();
          const saved = await put(`${base}/answer`, { text: answerBox.value }, answerStatus);
          if (saved) answerStatus.textContent = 'Correction saved. Re-evaluate to score it.';
        } }, 'Save correction'),
        q.editedAnswer !== null ? h('button', { className: 'btn small', onclick: async (ev) => {
          ev.stopPropagation();
          if (await put(`${base}/answer`, { text: null }, answerStatus)) load();
        } }, 'Revert to original') : null,
        h('button', { className: 'btn small primary', onclick: async (ev) => {
          ev.stopPropagation();
          if (await post(`${base}/reevaluate`, answerStatus)) {
            answerStatus.textContent = 'Re-evaluating… the report will refresh.';
            setTimeout(load, 2500);
          }
        } }, 'Re-evaluate'), answerStatus) : null),
    e ? h('div', { className: 'stack', style: 'gap:6px' },
      h('h3', {}, `AI score ${e.score}/100${q.override ? ` · Interviewer score ${q.override.finalScore}/100` : ''}${q.lowConfidence ? ' ⚠' : ''}`),
      q.override ? h('p', { className: 'small muted' }, `Override reason: ${q.override.overrideReason} (${q.override.overriddenBy})`) : null,
      ...DIMENSIONS.map(([k, label, w]) => h('div', { className: 'bd' }, h('span', {}, `${label} `, h('span', { className: 'muted small' }, `${w}%`)), bar(e.breakdown[k]), h('span', { className: 'num' }, e.breakdown[k]))),
      h('p', { className: 'small muted' }, `${e.evaluator === 'llm' ? `AI evaluator (${e.model})` : 'Demo keyword scorer'} · confidence ${Math.round(e.confidence * 100)}%`)) :
      h('p', { className: 'muted' }, q.status === 'no_answer' ? 'Not scored: no answer was captured.' : 'Not scored: AI evaluation was unavailable.'),
    e ? h('div', { className: 'stack', style: 'gap:6px' },
      h('h3', {}, 'Covered concepts'), list(e.coveredConcepts, 'ok'),
      h('h3', {}, 'Missing concepts'), list(e.missingConcepts, 'miss')) : null,
    e ? h('div', { className: 'stack', style: 'gap:6px' }, h('h3', {}, 'AI feedback'), list([...e.factualErrors.map((x) => `Error: ${x}`), ...e.strengths, ...e.improvements], 'plain')) : null,
    e?.followUpQuestion ? h('div', { className: 'stack', style: 'gap:6px' }, h('h3', {}, 'AI-suggested follow-up'), h('p', {}, e.followUpQuestion)) : null,
    q.evaluationHistory?.length > 1 ? h('div', { className: 'full stack', style: 'gap:6px' },
      h('h3', {}, `Evaluation history (${q.evaluationHistory.length} runs, newest first)`),
      h('ul', { className: 'clist plain' }, [...q.evaluationHistory].reverse().map((run) => h('li', {},
        `${run.score}/100 · ${fmtDate(run.evaluatedAt)} · ${run.trigger === 'reevaluate' ? 're-evaluated' : run.trigger === 'retry' ? 'retried' : 'automatic'} on ${run.answerSource} text · ${run.model}`)))) : null,
    h('div', { className: 'full stack', style: 'gap:6px' }, h('h3', {}, 'Interviewer note'), note,
      h('div', { style: 'display:flex;gap:12px;align-items:center' },
        h('button', { className: 'btn small', onclick: (ev) => { ev.stopPropagation(); put(`/api/interviews/${sessionId}/notes`, { questionId: q.questionId, text: note.value }, noteStatus); } }, 'Save note'), noteStatus)));
}

load();
