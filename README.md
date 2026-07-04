# AI Resume Builder

An ATS-friendly resume builder powered by a three-agent AI pipeline running on [Groq](https://groq.com) (free tier).

## How it works

The core is a **reflection / LLM-as-judge** pipeline with three agents:

1. **Extractor** — reads the job description + the user's raw details and pulls out the valuable, relevant information as structured JSON.
2. **Writer** — drafts an ATS-friendly resume from the extracted data.
3. **Judge** — evaluates the draft against ATS + quality criteria. If it fails, its feedback is passed back to the Writer, which revises. This loops until the Judge approves or a max-iteration cap is reached.

```
job description + user details
        │
        ▼
   [ Extractor ]  → structured JSON
        │
        ▼
   [ Writer ] ◄──────────┐
        │                │ feedback
        ▼                │
   [ Judge ] ── fail ────┘
        │
      pass
        ▼
   final resume
```

## Tech stack

- **Backend:** Node.js + Express
- **AI:** Groq API (OpenAI-SDK compatible), free tier
- **Models:** `openai/gpt-oss-20b` (extractor), `openai/gpt-oss-120b` (writer), `llama-3.3-70b-versatile` (judge)

## Setup

1. Clone the repo and install dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Get a free Groq API key at [console.groq.com](https://console.groq.com) (no credit card required).
3. Copy `.env.example` to `.env` and add your key:
   ```bash
   cp .env.example .env
   # then edit .env and set GROQ_API_KEY
   ```
4. Run the server:
   ```bash
   npm run dev
   ```
5. Test the pipeline:
   ```bash
   curl -X POST http://localhost:3000/api/generate \
     -H "Content-Type: application/json" \
     -d '{"jobDescription": "...", "userDetails": "..."}'
   ```

## Project structure

```
backend/
├── server.js            # Express entrypoint
├── pipeline.js          # the 3-agent loop
├── groqClient.js        # shared Groq API wrapper
├── agents/
│   ├── extractor.js
│   ├── writer.js
│   └── judge.js
└── prompts/
    ├── extractPrompt.js
    ├── writePrompt.js
    └── judgePrompt.js
```

## Roadmap

- [ ] Frontend (Next.js) with form + live preview
- [ ] PDF / DOCX export
- [ ] User accounts + saved resumes
- [ ] Keyword coverage score against the job description

## License

MIT
