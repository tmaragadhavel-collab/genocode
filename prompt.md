# CONTEXT-AWARE INTERVIEW INTELLIGENCE

## Phase 1 — Candidate Dashboard UI + Electron Foundation + Screen-Share Isolation

You are a senior software architect, product designer, and full-stack engineer with 13+ years of experience building production-grade SaaS products, real-time AI applications, desktop applications, interview platforms, and modern developer tools.

You are building a hackathon product called:

**Context-Aware Interview Intelligence**

The product is an AI-powered interview assistance platform for authorized interviews, mock interviews, and interview practice.

The product will eventually understand interview conversation and relevant visual context in real time and provide context-aware guidance to the candidate.

### IMPORTANT PRODUCT FRAMING

This product targets authorized and mock interviews and interview practice.

The **screen-share exclusion is a genuine technical goal of the product**, delivered via OS-level content protection in Electron (`BrowserWindow.setContentProtection(true)`), not merely a visual claim.

In this phase:

- Build the complete UI.
- Establish the Electron two-window architecture.
- Enable OS-level content protection on the private assistant window, controlled by a toggle (default ON).

Do NOT implement AI, speech-to-text, or any backend intelligence yet.

Do NOT claim in the UI that protection is guaranteed on every platform or every screen-sharing application. The UI must reflect the actual state of the toggle and recommend that the candidate verify with a test share.

---

# 1. PHASE 1 OBJECTIVE

Build a polished **Candidate Dashboard** with a production-quality SaaS UI, split across two Electron windows.

The product must show:

- Current interview question
- Live transcript
- AI suggestions
- Context/confidence indicators
- Privacy status
- Interview progress
- AI assistant interaction
- Real-time visual states
- Screen-share preview

At the same time, establish the correct **Electron two-window architecture**:

### Window 1 — Shareable Interview Workspace

Contains ONLY neutral interview UI:

- Current question
- Live transcript
- Interview progress
- Interview-related UI

This is the window intended to be shared with the interviewer. Nothing in it may reveal AI assistance.

### Window 2 — Private AI Assistant

Contains ALL AI-related UI:

- AI suggestions
- Hints
- Context information
- Follow-up suggestions
- Quick actions
- Privacy status
- Private assistant interaction

This is a separate Electron BrowserWindow with OS-level content protection enabled.

---

# 2. TECH STACK

Use:

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Lucide React
- Framer Motion

### Desktop Runtime

**Electron — initialize and configure from Phase 1.**

Set up:

- Electron main process
- Electron preload layer
- Typed `contextBridge` API
- IPC communication
- Two-window architecture
- Content protection on the assistant window
- Global hotkeys

### Build Tooling (STRICT)

Use **electron-vite** as the single build tool for the main process, preload, and renderer.

Both windows load the **same renderer** using separate hash routes:

```text
Main (shareable) window  →  /#/workspace
Assistant window         →  /#/assistant
```

Use a lightweight hash router (for example `react-router-dom` with `HashRouter`). Hash routing is required so routes work in both dev mode and the packaged build (`file://`).

### Backend

- Node.js
- Express.js
- MongoDB / MongoDB-ready architecture

For Phase 1, the backend contains only the structure/placeholders required for future features.

The `server/` folder is a placeholder and is **NOT started by `npm run dev`**.

Do NOT implement the real AI backend yet.

---

# 3. ELECTRON ARCHITECTURE

This is critical.

Create two Electron BrowserWindows.

## Main Window (Shareable Interview Workspace)

The window intended to be shared with the interviewer.

It contains:

- Interview question
- Transcript
- Interview progress
- Connection status
- Neutral interview UI

Configuration:

- Standard framed window
- Default size ~1280x800, minimum ~960x640
- Loads `/#/workspace`
- Content protection is NOT enabled on this window

## Assistant Window (Private AI Assistant)

A separate BrowserWindow.

Configure it as:

- Transparent
- Frameless
- Always-on-top
- Independently rendered
- Separate from the main window
- Loads `/#/assistant`
- Default size ~420x720
- Positioned at the right edge of the primary display's work area
- Resizable, width constrained to 360–480px
- `skipTaskbar: true`

Because the window is frameless, it MUST include:

- A visible drag handle at the top (`-webkit-app-region: drag`)
- Interactive elements inside the handle set to `-webkit-app-region: no-drag`
- Its own minimize/hide button (no native title bar exists)

### Content protection (Phase 1 — ENABLED)

In the Electron main process, isolate content protection in a dedicated function, for example in `electron/contentProtection.ts`:

```ts
export function setAssistantProtection(win: BrowserWindow, enabled: boolean) {
  win.setContentProtection(enabled);
}
```

Rules:

- Enable it on the assistant window at creation (default ON).
- Expose a toggle through IPC so the assistant UI can turn it on/off.
- The main process is the single source of truth for the protection state; broadcast the current state to both renderers after every change.
- Never enable content protection on the main (shareable) window.

Platform note to respect in UI copy: on Windows 10 (2004+) and Windows 11 this excludes the window from screen capture; behavior on other platforms and in some capture modes may differ. The UI must tell the candidate to verify with a test share.

### Global hotkeys

Register with `globalShortcut` in the main process:

```text
Ctrl+Shift+H   Show / hide the assistant window
Ctrl+Shift+P   Toggle content protection
```

Unregister all shortcuts on app quit.

---

# 4. PROJECT STRUCTURE

Use a single repository with one root `package.json`.

Use this structure (adapt paths to electron-vite conventions if required, but keep the separation):

```text
context-aware-interview/
│
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── windows.ts
│   │   ├── contentProtection.ts
│   │   ├── shortcuts.ts
│   │   └── ipc/
│   │       ├── channels.ts
│   │       └── handlers.ts
│   │
│   ├── preload/
│   │   ├── index.ts
│   │   └── index.d.ts
│   │
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── assets/
│           ├── components/
│           ├── pages/
│           ├── hooks/
│           ├── services/
│           ├── stores/
│           ├── types/
│           └── data/
│
├── server/
│   └── index.ts
│
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

Do NOT use:

- Create React App
- Next.js
- Multiple competing frontend shells
- A second Vite config outside electron-vite

Keep the architecture simple and consistent.

---

# 5. IPC ARCHITECTURE

Create a typed IPC interface between:

```text
Main Electron Process
        ↕
     Preload
        ↕
Renderer (both windows)
```

The renderer must NOT directly access Node.js APIs.

Use `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

Expose only the required APIs through `contextBridge`.

Define all channel names in one shared constants file (`channels.ts`) with typed payloads.

Create mock IPC communication between:

```text
Shareable Interview Window
          ↕
     Main Process (relay)
          ↕
Private Assistant Window
```

The main process relays messages between windows; windows never talk to each other directly.

Example flow:

```text
Interview question updated (workspace)
        ↓
IPC → main process
        ↓
Relayed to assistant window
        ↓
Assistant UI updates with new context
```

Use mock data for now.

---

# 6. PRODUCT DESIGN

The application should look like a premium modern SaaS product.

Design inspiration:

- Modern AI SaaS
- ChatGPT/Claude-style interfaces
- Developer productivity tools
- Modern interview platforms
- Enterprise SaaS dashboards

The UI must look like a real startup product, NOT a college project.

Prioritize:

- Excellent spacing
- Strong visual hierarchy
- Clean typography
- Rounded cards
- Subtle shadows
- Professional icons
- Smooth transitions
- Responsive layout
- Clear navigation
- Excellent loading states
- Excellent empty states
- Accessibility

Avoid:

- Excessive gradients
- Excessive glassmorphism
- Too many colors
- Huge typography
- Clutter
- Random animations
- Generic dashboard templates

Use one sophisticated primary accent color with neutral surfaces.

The assistant window is transparent at the OS level, but its content must sit on a solid, readable surface (rounded panel with a subtle border and shadow). Do not rely on transparency for readability.

---

# 7. USER ROLE

Primary role:

**Candidate**

Example candidate:

```text
Alex Morgan
AI Engineer
```

The product should feel like a personal AI interview co-pilot.

The UX should be:

- Calm
- Intelligent
- Friendly
- Fast
- Non-distracting
- Easy to understand during a live interview

---

# 8. WINDOW PLACEMENT (STRICT)

This section overrides any other section if there is a conflict.

### Shareable Interview Window (`/#/workspace`) contains ONLY neutral interview UI:

- Sidebar (WITHOUT any AI Assistant navigation item)
- Header (session title, role, interview type, connection status — NO AI or privacy badges)
- Current Question
- Live Transcript
- Interview Progress

### Private Assistant Window (`/#/assistant`) contains ALL AI-related UI:

- AI Interview Copilot panel
- Quick Insight, Key Points, Suggested Direction, Possible Follow-up
- Context Awareness card
- Privacy Status card (with the content protection toggle)
- Quick Actions
- Chat input
- Screen-Share Preview toggle
- Assistant state indicators (Analyzing Context, Suggestion Ready, Paused)
- Microphone / screen-context / AI-processing indicators

**Nothing that reveals AI assistance may render in the Shareable Window** — no text, icons, badges, tooltips, toasts, notifications, or nav items referencing AI, hints, copilot, or private assistance.

---

# 9. APPLICATION SHELL

### Shareable Interview Window

```text
┌─────────────────────────────────────────────────────┐
│ Sidebar │ Header                                    │
│         ├───────────────────────────────────────────┤
│         │                                           │
│         │       Interview Workspace                 │
│         │                                           │
│         │  Question / Transcript / Progress         │
│         │                                           │
└─────────────────────────────────────────────────────┘
```

### Private Assistant Window

```text
┌──────────────────────────┐
│ ⠿ Drag handle   🔒  —    │
├──────────────────────────┤
│ AI Interview Copilot     │
│ Status                   │
├──────────────────────────┤
│ Quick Insight            │
│ Key Points               │
│ Suggested Direction      │
│ Possible Follow-up       │
├──────────────────────────┤
│ Context Awareness        │
│ Privacy Status           │
├──────────────────────────┤
│ Quick Actions            │
├──────────────────────────┤
│ Ask your AI assistant... │
└──────────────────────────┘
```

The assistant window scrolls internally; the drag handle and chat input stay pinned.

---

# 10. SIDEBAR (Shareable Window)

Create a modern collapsible sidebar.

Brand:

**InterviewAI**

Use a polished productivity icon.

Navigation:

- Dashboard
- Interviews
- Practice
- Insights
- History
- Resources

Workspace section:

- Current Interview
- Transcript

(Do NOT include an "AI Assistant" item in this window.)

Bottom:

- Help & Support
- Settings
- Candidate Profile

Profile:

```text
Alex Morgan
AI Engineer
```

Avatar: use a local image in `renderer/src/assets` or an initials fallback. **No external image URLs anywhere in the app** — the demo must work fully offline.

Sidebar requirements:

- Expanded mode
- Collapsed mode
- Tooltips
- Smooth animation

---

# 11. HEADER (Shareable Window)

Create a professional top header.

Display:

```text
Technical Interview
● Live Session
```

Role:

```text
AI Engineer
```

Interview type:

```text
Technical Round
```

Right side:

- Connection status
- Notification icon
- Candidate avatar
- Settings

Connection:

```text
● Connected
```

Do NOT show a privacy or "Private Assistance" badge in this header. Privacy status lives only in the assistant window.

---

# 12. CURRENT QUESTION (Shareable Window)

Create a large modern card.

Title:

**Current Question**

Status:

**Question detected**

Use this example:

> "Can you explain how a Convolutional Neural Network works and why pooling layers are used?"

Metadata:

```text
Topic: Deep Learning
Difficulty: Intermediate
Time: 00:04:32
```

Add:

- Pin
- Copy
- More

Add a subtle activity/waveform indicator.

When the question changes (mock), send `QUESTION_UPDATED` over IPC to the assistant window.

---

# 13. LIVE TRANSCRIPT (Shareable Window)

Create a modern chat-style transcript.

Title:

**Live Transcript**

Status:

```text
Listening...
```

Example:

```text
INTERVIEWER

Can you explain how a CNN works?

10:42:18


CANDIDATE

A CNN uses convolution layers to extract
features from an image...

10:42:23


INTERVIEWER

And why do we use pooling?
```

Differentiate:

- Interviewer
- Candidate
- System events (neutral only, e.g. "Session started" — never AI events in this window)

Use timestamps.

At the bottom:

```text
🎙 Listening...
```

Use a subtle animated audio indicator.

Use mock streaming text animation so the UI feels live.

---

# 14. PRIVATE AI ASSISTANT (Assistant Window)

Title:

**AI Interview Copilot**

Status:

```text
Analyzing context...
```

Create sections:

### QUICK INSIGHT

> Your interviewer is testing your understanding of CNN fundamentals and feature extraction.

### KEY POINTS

- Convolution extracts spatial features
- Filters detect patterns
- Pooling reduces spatial dimensions
- CNNs learn hierarchical representations

### SUGGESTED DIRECTION

> Start with the purpose of convolution, then explain feature maps and pooling.

### POSSIBLE FOLLOW-UP

> Why is pooling useful for reducing computation?

The assistant should feel like a specialized interview coach rather than a generic chatbot.

---

# 15. CONTEXT AWARENESS (Assistant Window)

Create a context card.

Display:

```text
Context Confidence
92%
```

Signals:

```text
✓ Current question
✓ Previous conversation
✓ Interview role
✓ Topic detected
✓ Conversation history
```

Display:

```text
Detected Topic:
Deep Learning

Subtopic:
Convolutional Neural Networks

Interview Stage:
Technical Discussion
```

Use a polished circular/ring progress indicator. Keep it compact for the narrow window.

---

# 16. PRIVACY STATUS (Assistant Window)

Create a dedicated privacy card.

Title:

**Private Assistance**

Status reflects the REAL content-protection state from the main process:

```text
ON   →  Protected
OFF  →  Visible in screen share
```

Description (when ON):

> This assistant window is excluded from screen capture by the operating system. Verify with a test share before your interview.

Display:

```text
🔒 Private

Screen Share:
Interview workspace only

Assistant:
Excluded from capture
```

Include:

- A toggle switch bound to content protection (IPC)
- A hint showing the hotkey `Ctrl+Shift+P`
- A clear warning state (amber, not red) when protection is OFF

Never claim protection is guaranteed on every platform or in every screen-sharing app.

---

# 17. INTERVIEW PROGRESS (Shareable Window)

Display:

```text
Interview Progress

████████░░ 68%
```

Topics:

```text
✓ Introduction
✓ Python
✓ Machine Learning
→ Deep Learning
○ System Design
○ Closing
```

Time:

```text
Elapsed: 18:42
Remaining: 11:18
```

---

# 18. QUICK ACTIONS (Assistant Window)

Create:

- Ask AI
- Show Hint
- Explain More
- Summarize
- Focus Mode
- Pause Assistance

Use mock state. All actions live and act inside the assistant window.

Examples:

Click **Show Hint** → assistant panel updates with a hint.

Click **Explain More** → assistant expands the current suggestion.

Click **Focus Mode** → assistant collapses to only the current key points and the chat input.

Click **Pause Assistance** → assistant shows a Paused state and stops mock updates until resumed.

---

# 19. CHAT-LIKE AI INTERACTION (Assistant Window)

At the bottom of the assistant window (pinned):

```text
Ask your AI assistant...
```

Buttons:

- Send
- Voice
- Context/attachment

Implement mock keyword responses.

Example:

User:

> What should I mention about pooling?

Assistant:

> Explain that pooling reduces spatial dimensions, lowers computation, and provides some translation invariance.

Structure `mockAIService.ts` behind an interface (e.g. `AIService`) so it can later be replaced with a real AI API without changing components.

---

# 20. REAL-TIME VISUAL STATES

Create realistic states:

```text
Listening           (workspace + assistant)
Processing          (assistant)
Analyzing Context   (assistant)
Suggestion Ready    (assistant)
Connected           (workspace + assistant)
Paused              (assistant)
```

Use subtle animations:

- Pulsing microphone
- Streaming transcript
- AI thinking indicator (assistant only)
- Smooth card transitions
- Context confidence animation (assistant only)

Do NOT overanimate.

---

# 21. SCREEN-SHARE PREVIEW (Assistant Window)

Add a **Screen-Share Preview** toggle inside the assistant window.

When enabled, show a side-by-side panel (it may open as an expanded view within the assistant window):

```text
┌─────────────────────────┬─────────────────────────┐
│ WHAT YOU SEE            │ WHAT INTERVIEWER SEES   │
│                         │                         │
│ Interview Workspace     │ Interview Workspace     │
│                         │                         │
│ + Private AI Assistant  │                         │
│                         │ AI Assistant absent     │
└─────────────────────────┴─────────────────────────┘
```

The right side must reflect the real protection state:

- Protection ON → assistant shown as absent
- Protection OFF → assistant shown as VISIBLE, with an amber warning

Label clearly:

**Illustrative preview — verify with a real test share (e.g. Google Meet → Present → Entire screen).**

---

# 22. RESPONSIVE DESIGN

Primary target: desktop/laptop.

### Shareable Window

- Supports widths down to its minimum (~960px) and tablet-like sizes
- Collapse sidebar at smaller widths
- Reorganize cards
- Preserve transcript readability

### Assistant Window

- Fixed-width panel; must stay fully usable from **360–480px** width
- Sections stack vertically and scroll internally
- Drag handle and chat input stay pinned

---

# 23. LIGHT/DARK MODE

Implement:

- Light mode
- Dark mode

Both must be intentionally designed. Do not simply invert colors.

The theme must stay in sync across both windows (broadcast theme changes over IPC).

---

# 24. COMPONENT ARCHITECTURE

Use reusable components.

```text
renderer/src/

components/
├── layout/
│   ├── WorkspaceShell.tsx
│   ├── AssistantShell.tsx
│   ├── Sidebar.tsx
│   ├── Header.tsx
│   └── DragHandle.tsx
│
├── interview/
│   ├── CurrentQuestion.tsx
│   ├── LiveTranscript.tsx
│   └── InterviewProgress.tsx
│
├── assistant/
│   ├── AIAssistant.tsx
│   ├── AIMessage.tsx
│   ├── QuickInsight.tsx
│   ├── KeyPoints.tsx
│   ├── SuggestedDirection.tsx
│   ├── FollowUpQuestion.tsx
│   ├── QuickActions.tsx
│   └── ChatInput.tsx
│
├── context/
│   ├── ContextIndicator.tsx
│   └── ContextSignals.tsx
│
├── privacy/
│   ├── PrivacyStatus.tsx
│   └── ProtectionToggle.tsx
│
├── preview/
│   └── ScreenSharePreview.tsx
│
└── ui/

pages/
├── WorkspacePage.tsx      (route: /workspace)
└── AssistantPage.tsx      (route: /assistant)

hooks/
├── useInterview.ts
├── useTranscript.ts
├── useAssistant.ts
├── useProtection.ts
└── useIpc.ts

services/
├── aiService.ts           (interface)
├── mockAIService.ts
├── ipcClient.ts
└── api.ts

stores/
├── interviewStore.ts
└── assistantStore.ts

types/
├── interview.ts
├── transcript.ts
├── assistant.ts
└── ipc.ts

data/
└── mockInterview.ts
```

Do not create one massive component.

---

# 25. STATE MANAGEMENT

Use Zustand where global state is appropriate.

Important: each Electron window runs its own renderer process, so **Zustand stores are NOT shared between windows**. Cross-window state (current question, protection state, theme, assistance paused) must be synchronized through IPC via the main process.

Prepare state for:

- Current question
- Transcript
- AI suggestions
- Interview status
- Context confidence
- Privacy / content-protection status
- Assistant status
- Focus mode
- Screen-share preview
- Theme

Keep the state architecture ready for future WebSocket integration.

---

# 26. MOCK DATA

Candidate:

```text
Alex Morgan
AI Engineer
```

Current topic:

```text
Deep Learning
```

Current question:

```text
Can you explain how a Convolutional Neural Network works
and why pooling layers are used?
```

Create realistic interview conversation (at least 3–4 question changes over time so IPC updates are visible).

Do NOT use lorem ipsum.

---

# 27. MOCK IPC

Define channels in `channels.ts`:

```text
QUESTION_UPDATED            workspace → main → assistant
TRANSCRIPT_APPENDED         workspace → main → assistant
PROTECTION_SET              assistant → main
PROTECTION_STATE_CHANGED    main → both windows
ASSISTANT_TOGGLE_VISIBILITY assistant → main
THEME_CHANGED               any → main → both windows
```

Example payload:

```ts
{
  question: string;
  topic: string;
  confidence: number;
}
```

The assistant window must update when the mock question changes.

The assistant overlay must render independently and receive mock data over IPC.

---

# 28. PRIVACY-FIRST DESIGN

Treat privacy as a first-class UX concept.

Show clear indicators (in the assistant window only) for:

- Microphone active
- Screen context active
- AI processing
- Content protection ON/OFF
- What is shareable (interview workspace) vs. private (assistant)

Do not make false claims about technical protection beyond what the OS provides.

---

# 29. QUALITY BAR

Before finishing:

- No placeholder text
- No broken icons
- No console errors
- No TypeScript errors
- No build errors
- Buttons have sensible mock interactions
- Responsive behavior works
- Dark/light mode works and syncs across windows
- Scrolling works
- Keyboard accessibility works
- Hover/focus states work
- Consistent spacing
- Typography is polished
- Electron windows open correctly
- Assistant overlay renders independently and can be dragged
- Hotkeys work (`Ctrl+Shift+H`, `Ctrl+Shift+P`)
- IPC mock communication works
- Content protection toggle works and state is reflected in both windows
- Screen-share preview reflects the real protection state
- No AI-related UI appears anywhere in the shareable window
- No external network requests (fonts, images, avatars must be local)

Also create:

```text
.env.example
```

Never commit secrets.

---

# 30. NPM SCRIPTS

Create scripts for:

```text
npm run dev        launches the full Electron dev environment (electron-vite dev)
npm run build      production build (electron-vite build)
npm run preview    runs the built app
npm run typecheck  TypeScript check for main, preload, and renderer
```

Optionally:

```text
npm run server:dev   starts the placeholder Express server (not used in Phase 1 demo)
```

---

# 31. ENVIRONMENT

Target environment:

```text
Windows 11
PowerShell
VS Code
Node.js LTS
```

IMPORTANT:

Provide all setup/run commands **one per line**.

Do NOT use:

```text
command1 && command2
```

Do NOT use PowerShell backtick line continuations.

Every command should be independently runnable.

After scaffolding:

1. Run `npm run dev`.
2. Confirm the main interview window opens.
3. Confirm the private assistant window opens at the right edge.
4. Confirm mock IPC communication works (question change updates the assistant).
5. Confirm the hotkeys work.
6. Confirm the protection toggle updates both windows.

Then give me short manual test steps to verify screen-share exclusion in Google Meet (Present → Entire screen) with a second device or browser viewing the share.

---

# 32. FUTURE PHASE BOUNDARY

Do NOT implement these yet:

- Real AI
- Real speech-to-text
- System audio capture
- WebSockets
- Real screen capture / screen understanding
- Vision processing
- SerpAPI
- Real MongoDB functionality
- Authentication
- Real-time AI backend

However, prepare clean interfaces so these features can be added later without rewriting the architecture.

OS-level content protection IS implemented in this phase (Section 3).

---

# 33. DEVELOPMENT PROCESS

Before coding:

1. Inspect the existing repository.
2. Identify framework and existing files.
3. Identify existing dependencies.
4. Reuse useful code where appropriate.
5. Do not blindly overwrite existing work.

If no application exists, initialize the requested architecture.

Then:

1. Scaffold electron-vite with React + TypeScript.
2. Build Electron foundation (two windows, preload, security settings).
3. Add content protection module and hotkeys.
4. Build IPC channels and relay.
5. Set up Tailwind, shadcn/ui, hash routing.
6. Build shareable workspace window UI.
7. Build private assistant window UI.
8. Add mock interactions and mock streaming.
9. Add screen-share preview.
10. Test both windows, hotkeys, and IPC.
11. Fix all errors.
12. Run typecheck and production build.

---

# 34. SENIOR ENGINEER BEHAVIOR

Act like a 13+ year senior engineer.

Do not blindly follow instructions if they create bad architecture.

If you identify a technical conflict:

- Explain it briefly.
- Choose the cleanest production-grade solution.
- Implement it consistently.

Section 8 (Window Placement) takes priority over any other section.

Prioritize:

- Maintainability
- Security
- Privacy
- Performance
- Accessibility
- Clean architecture
- Excellent UX

Do not over-engineer the Phase 1 implementation.

---

# 35. FINAL RESPONSE AFTER IMPLEMENTATION

After implementation, provide a concise report containing:

### Files created

List them.

### Files modified

List them.

### Dependencies added

List them.

### Commands

Show exactly how to run the application (one command per line).

### What currently works

List:

- Candidate Dashboard (shareable workspace)
- Electron main window
- Private assistant window
- Content protection + toggle + hotkeys
- IPC communication
- Mock AI
- Screen-share preview
- Dark/light mode
- Responsive UI

### What is mocked

Clearly identify what is not yet real.

### Screen-share verification steps

Short manual steps to prove the assistant is excluded from a real share.

### Next recommended phase

Do NOT implement it.

Only tell me what the next phase should be.

---

# FINAL REQUIREMENT

The final result should feel like a polished commercial AI SaaS product.

The candidate should immediately understand:

1. What question is being asked?
2. What is the interviewer saying?
3. What does the AI recommend?
4. How confident is the AI?
5. What context has been detected?
6. Is the assistance private?
7. What is being shared?
8. What stage of the interview are they in?
9. Is the system listening or processing?

Most importantly:

**The Phase 1 architecture must establish a strict separation between the shareable Interview Workspace window (no AI traces at all) and the private AI Assistant Electron window (content-protected, toggleable).**

Do not implement later AI functionality yet.

Build Phase 1 completely, test it, and stop.
