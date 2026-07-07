import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Resolve .env from the repo root (two levels up from lib/groqClient.js)
// so `dotenv.config()` finds it regardless of where `node` is invoked from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MOCK_MODE = process.env.MOCK_MODE === "true";

// Collect every configured Groq key. We support GROQ_API_KEY plus numbered
// extras (GROQ_API_KEY_2, GROQ_API_KEY_3, ...) so you can spread load across
// multiple accounts, each of which has its own independent TPM limit. Add as
// many as you like — the pool round-robins across all of them and fails over
// to another key when one is rate-limited.
//
// NOTE: Running several free accounts to raise your effective rate limit may
// conflict with Groq's acceptable-use terms. For production, the sanctioned
// path is upgrading to a paid tier. This is fine for a personal/portfolio app,
// but know the tradeoff.
function collectApiKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  // De-dupe in case the same key is set twice.
  return [...new Set(keys)];
}

const API_KEYS = collectApiKeys();

if (API_KEYS.length === 0 && !MOCK_MODE) {
  console.warn(
    "[groqClient] Warning: no GROQ_API_KEY set. Copy .env.example to .env and add your key(s), or set MOCK_MODE=true."
  );
} else if (API_KEYS.length > 1) {
  console.log(`[groqClient] ${API_KEYS.length} API keys loaded — round-robin + failover enabled.`);
}

// Groq is OpenAI-SDK compatible — we just point the base URL at Groq. One
// client per key so requests carry the right credential.
const clients = (API_KEYS.length ? API_KEYS : ["mock"]).map(
  (apiKey) => new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" })
);

// Round-robin cursor. Each call advances it so consecutive requests land on
// different keys, spreading token usage evenly across the accounts.
let rrCursor = 0;
function nextClientOrder() {
  // Returns the client indices to try, starting at the round-robin position and
  // wrapping around — so a rate-limited first choice fails over to the rest.
  const n = clients.length;
  const start = rrCursor % n;
  rrCursor = (rrCursor + 1) % n;
  return Array.from({ length: n }, (_, i) => (start + i) % n);
}

/**
 * Create a chat completion, round-robining across the configured keys and
 * failing over to another key when one is rate-limited (429). The round-robin
 * cursor advances once per logical call (chosen by the caller), and this helper
 * walks the remaining keys in order if the first is throttled.
 *
 * A 413 (request genuinely too large for the model's TPM) is NOT retried here —
 * another key has the same limit, so the size problem must be handled by the
 * caller (shrinking max_tokens). We only fail over on 429, where a fresh key's
 * unused per-minute budget actually helps.
 *
 * @param {number[]} order  - client indices to try, in preference order
 * @param {Object} params   - OpenAI-compatible completion params
 */
async function createCompletion(order, params) {
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    try {
      return await clients[idx].chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      // Only fail over on a pure rate-limit (429). A 413 is a size problem that
      // every key shares, so let it propagate to the caller's shrink logic.
      if (status === 429 && i < order.length - 1) {
        console.warn(`[groqClient] key #${idx + 1} rate-limited (429); failing over to next key`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Call a Groq chat model.
 * @param {Object} opts
 * @param {string} opts.agent      - "extractor" | "writer" | "judge" (used for mock mode + logging)
 * @param {string} opts.model      - Groq model ID
 * @param {string} opts.system     - system prompt
 * @param {string} opts.user       - user message
 * @param {boolean} [opts.json]    - request JSON output
 * @param {number} [opts.temperature]
 * @returns {Promise<string>} the model's text response
 */
export async function callGroq({ agent, model, system, user, json = false, temperature = 0.7, maxTokens = 4096 }) {
  if (MOCK_MODE) return mockResponse(agent);

  // Groq's JSON mode requires the word "JSON" to appear somewhere in the
  // prompt. Our prompts already say "JSON", but we guard the system message
  // so a prompt edit can never silently trip the 400 "response_format" error.
  const systemContent =
    json && !/json/i.test(system + user)
      ? `${system}\n\nRespond with a single valid JSON object.`
      : system;

  // Per-minute token ceilings (input + output combined) for the free/on-demand
  // tier. TPM counts the prompt AND the reserved max_tokens together, so a
  // single call must satisfy: promptTokens + max_tokens <= TPM. We clamp
  // max_tokens to whatever headroom is left after the prompt so a large input
  // can never trip a 413 "request too large" on its own.
  const promptTokens = estimateTokens(systemContent) + estimateTokens(user);
  const tpm = MODEL_TPM[model] ?? 6000;          // conservative default
  const headroom = Math.max(tpm - promptTokens - TPM_SAFETY_MARGIN, 256);
  const safeMaxTokens = Math.min(maxTokens, headroom);

  const params = {
    model,
    temperature,
    max_tokens: safeMaxTokens,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: user },
    ],
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };

  // Pick this call's key order once, so the initial attempt and any retries all
  // start from the same round-robin position and share the same failover chain.
  const order = nextClientOrder();

  try {
    const response = await createCompletion(order, params);
    return response.choices[0].message.content;
  } catch (err) {
    const status = err?.status ?? err?.response?.status;

    // A 413 means prompt + max_tokens already exceeded the model's TPM. Retrying
    // with MORE tokens would guarantee another 413, so we shrink instead: drop
    // max_tokens to the minimum viable size and try once more. If the prompt
    // alone is over budget, no output size can help — surface a clear message.
    if (status === 413) {
      const shrunk = Math.max(headroom - 512, 256);
      if (shrunk < safeMaxTokens && promptTokens + 256 < tpm) {
        const retry = await createCompletion(order, { ...params, max_tokens: shrunk });
        return retry.choices[0].message.content;
      }
      throw makeTpmError(model, tpm, promptTokens);
    }

    // Groq's JSON mode returns a 400 with the model's raw (invalid) output
    // attached as `failed_generation` when it can't validate the result. The
    // usual cause is the object being truncated at max_tokens mid-structure.
    // The OpenAI SDK nests the body under err.error, so Groq's own
    // { error: { failed_generation } } ends up at err.error.error.failed_generation.
    // We check every plausible location to be robust across SDK versions.
    const failed =
      err?.error?.error?.failed_generation ||
      err?.error?.failed_generation ||
      err?.failed_generation ||
      err?.response?.data?.error?.failed_generation;
    if (json && (failed || status === 400)) {
      // 1) Try to salvage the partial output first — often it's complete or
      //    only missing a closing brace, which parseJsonResponse can recover.
      if (failed) {
        try {
          parseJsonResponse(failed);
          return failed; // parseable as-is; hand it back to the caller
        } catch {
          // not salvageable — fall through to a real retry
        }
      }
      // 2) Retry deterministically with slightly MORE room for the output, but
      //    never past the TPM headroom (that would 413). We only nudge up to
      //    the remaining budget, not a blind doubling.
      const retryTokens = Math.min(Math.max(safeMaxTokens, Math.floor(headroom * 0.9)), headroom);
      try {
        const retry = await createCompletion(order, {
          ...params,
          temperature: 0,
          max_tokens: retryTokens,
        });
        return retry.choices[0].message.content;
      } catch (retryErr) {
        // The retry failed too. Salvage its partial output if Groq attached one,
        // otherwise surface a clear message instead of Groq's cryptic
        // "Failed to validate JSON" (which is meaningless to the end user).
        const retryFailed =
          retryErr?.error?.error?.failed_generation ||
          retryErr?.error?.failed_generation ||
          retryErr?.failed_generation ||
          retryErr?.response?.data?.error?.failed_generation;
        if (retryFailed) {
          try {
            parseJsonResponse(retryFailed);
            return retryFailed;
          } catch {
            /* still unsalvageable */
          }
        }
        throw makeJsonError(agent);
      }
    }
    throw err;
  }
}

// Free/on-demand tier per-minute token limits, by model. Update if you change
// tiers. Combined input+output must stay under these.
const MODEL_TPM = {
  "openai/gpt-oss-20b": 8000,
  "openai/gpt-oss-120b": 8000,
  "llama-3.3-70b-versatile": 12000,
};
const TPM_SAFETY_MARGIN = 300; // headroom for tokenizer estimate error

// Rough token estimate: ~4 chars per token for English text. Deliberately a
// slight over-estimate (chars/3.6) so we under-request rather than 413.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

function makeTpmError(model, tpm, promptTokens) {
  const e = new Error(
    `The input is too large for ${model} (needs ~${promptTokens} tokens, limit ${tpm}/min). ` +
      `Try a shorter resume or job description.`
  );
  e.status = 413;
  return e;
}

// Friendly message for when a model twice returns JSON we can't parse or repair.
// Groq's own "Failed to validate JSON" is meaningless to end users.
function makeJsonError(agent) {
  const e = new Error(
    `The AI had trouble formatting its response (${agent}). This is usually temporary — please try again.`
  );
  e.status = 502;
  return e;
}

/** Safely parse a JSON string returned by a model. Throws a clear error on failure. */
export function parseJsonResponse(text) {
  if (typeof text !== "string") {
    throw new Error("Model returned no text to parse as JSON.");
  }

  // First try: parse as-is (the happy path with JSON mode).
  try {
    return JSON.parse(text);
  } catch {
    // fall through to tolerant extraction
  }

  // Tolerant path: strip ```json fences and grab the outermost {...} or [...]
  // in case the model added a stray sentence before/after the object.
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const firstBrace = cleaned.search(/[{[]/);
  const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: the object was truncated mid-stream (Groq hit max_tokens),
    // so it's missing closing braces/brackets. Walk the string tracking string
    // state, drop any trailing partial token, and append the missing closers.
    const repaired = closeTruncatedJson(cleaned);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        /* fall through to the thrown error below */
      }
    }
    throw new Error(
      `Failed to parse model JSON response. Raw output:\n${text}\n\nError: JSON was invalid or truncated.`
    );
  }
}

/**
 * Best-effort repair of JSON that was cut off mid-object (the usual result of
 * hitting max_tokens in Groq's JSON mode). Tracks brace/bracket depth while
 * respecting string literals and escapes, trims any dangling partial value,
 * and closes the open structures. Returns null if it can't produce something
 * plausibly parseable.
 */
function closeTruncatedJson(s) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1; // index just after the last complete value/pair

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') { inString = false; lastSafe = i; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") { stack.pop(); lastSafe = i; }
    else if (ch === "," ) lastSafe = i - 1; // cut before a trailing comma
    else if (/[\d}\]e"]/.test(ch)) lastSafe = i;
  }

  if (stack.length === 0) return null; // not actually truncated

  // Trim back to the last complete token, drop a trailing comma, then close.
  let body = s.slice(0, lastSafe + 1).replace(/,\s*$/, "");
  while (stack.length) body += stack.pop();
  return body;
}

/* ---------------------------------------------------------------------------
 * MOCK MODE — lets you develop and test the whole app without an API key
 * and without burning Groq rate limits. Set MOCK_MODE=true in .env.
 * The mock judge rejects the first draft and approves the second, so you can
 * see the full feedback loop in action.
 * ------------------------------------------------------------------------- */
let mockJudgeCalls = 0;

async function mockResponse(agent) {
  await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS ?? 700))); // simulate latency

  if (agent === "extractor") {
    return JSON.stringify({
      targetRole: "Junior Data Scientist",
      keywordsFromJob: ["Python", "SQL", "machine learning", "pandas", "data visualization", "TensorFlow"],
      matchedSkills: ["Python", "SQL", "pandas", "machine learning"],
      relevantExperience: [
        {
          title: "Data Science Intern",
          org: "Example Corp",
          dates: "Jun 2025 – Aug 2025",
          achievements: ["Built a churn model in Python improving retention targeting by 18%"],
        },
      ],
      education: [
        { degree: "B.S. Computer Science (Data Science)", institution: "State University", dates: "2022 – 2026" },
      ],
      projects: [
        { name: "AI Resume Builder", description: "Three-agent LLM pipeline on Groq", tech: ["Node.js", "Express", "LLMs"] },
      ],
      contact: { name: "Sample Candidate", email: "sample@email.com", phone: "+63 900 000 0000", links: ["github.com/sample"] },
    });
  }

  if (agent === "writer") {
    const revision = mockJudgeCalls > 0 ? " (revised with judge feedback)" : "";
    return `# Sample Candidate
sample@email.com | +63 900 000 0000 | github.com/sample

## Professional Summary
Data science fresh graduate${revision} with hands-on experience in Python, SQL, and machine learning through internships and shipped projects.

## Skills
Python, SQL, pandas, machine learning, data visualization

## Work Experience
**Data Science Intern — Example Corp** (Jun 2025 – Aug 2025)
- Built a churn prediction model in Python, improving retention targeting by 18%
- Automated weekly SQL reporting, saving 4 hours per week

## Projects
**AI Resume Builder** — Three-agent LLM pipeline (extractor, writer, judge) on Groq using Node.js and Express

## Education
**B.S. Computer Science (Data Science)** — State University (2022 – 2026)`;
  }

  if (agent === "judge") {
    mockJudgeCalls++;
    if (mockJudgeCalls === 1) {
      return JSON.stringify({
        approved: false,
        score: 68,
        feedback:
          "Add the missing keywords 'TensorFlow' and 'data visualization' to the Skills or Projects section, and quantify at least one more bullet.",
      });
    }
    mockJudgeCalls = 0; // reset for the next run
    return JSON.stringify({ approved: true, score: 88, feedback: "" });
  }

  if (agent === "suggester") {
    return JSON.stringify({
      section: "skills",
      suggestions: [
        { text: "Python", hint: "Core requirement in the job post — list it if you've used it in any course or project." },
        { text: "SQL", hint: "The role involves querying data; even coursework counts." },
        { text: "pandas", hint: "Standard for data wrangling in Python — mention if you've cleaned datasets." },
        { text: "Data visualization", hint: "They want you to communicate findings; Matplotlib/Tableau experience fits here." },
        { text: "Git / version control", hint: "Almost always expected — include if you've used GitHub for any project." },
        { text: "Communication", hint: "A soft skill the post emphasizes; think of presentations you've given." },
      ],
    });
  }

  if (agent === "roles") {
    return JSON.stringify({
      roles: [
        { title: "Junior Data Analyst", fit: "strong", why: "Your Python, SQL, and dashboard work map directly to entry-level analytics.", searchKeywords: ["junior data analyst", "entry level data analyst", "data analyst graduate"] },
        { title: "Data Science Intern / Associate", fit: "strong", why: "Your internship and ML project experience fit associate-level data science.", searchKeywords: ["data science associate", "junior data scientist", "data science intern"] },
        { title: "Business Intelligence Analyst", fit: "good", why: "Your Tableau and SQL skills translate well to BI reporting roles.", searchKeywords: ["BI analyst", "business intelligence analyst entry level"] },
        { title: "Machine Learning Engineer", fit: "stretch", why: "A reach role — your TensorFlow project is a start, but most postings want more production experience.", searchKeywords: ["junior ML engineer", "machine learning engineer entry level"] },
      ],
      generalAdvice: "As a fresh graduate, lead with your projects and quantified internship results, and apply broadly to junior/analyst titles while treating ML engineer roles as stretch goals.",
    });
  }

  if (agent === "resumeParser") {
    return JSON.stringify({
      personal: {
        firstName: "Sample",
        lastName: "Candidate",
        email: "sample@email.com",
        phone: "+63 900 000 0000",
        location: "Davao City, Philippines",
        linkedin: "linkedin.com/in/sample",
        github: "github.com/sample",
        portfolio: "",
      },
      education: "B.S. Computer Science (Data Science)\nState University, 2022 – 2026\nGPA: 3.7",
      experience: "Data Science Intern — Example Corp (Jun 2025 – Aug 2025)\n- Built a churn prediction model in Python, improving retention targeting by 18%\n- Automated weekly SQL reporting, saving 4 hours per week",
      skills: "Python, SQL, pandas, scikit-learn, TensorFlow, Tableau, Matplotlib, JavaScript, Git",
      projects: "AI Resume Builder: three-agent LLM pipeline (Node.js, Express, Groq)\nSales dashboard in Tableau for a capstone project",
    });
  }

  if (agent === "coach") {
    return JSON.stringify({
      focusAreas: [
        { topic: "TensorFlow fundamentals", why: "Listed as a core requirement and missing from your background", priority: "high" },
        { topic: "Data visualization (Matplotlib/Tableau)", why: "The role emphasizes communicating findings to stakeholders", priority: "high" },
        { topic: "SQL query optimization", why: "You have SQL basics; this role needs production-level data work", priority: "medium" },
      ],
      skillsToStrengthen: ["TensorFlow / deep learning basics", "Data storytelling & dashboards", "Explaining ML models to non-technical audiences"],
      quickWins: [
        "Build one small TensorFlow project (e.g. an image or text classifier) and put it on GitHub",
        "Add a Tableau or Matplotlib dashboard to your churn project to show visualization skills",
        "Write a short README explaining your churn model's business impact",
      ],
      interviewQuestions: [
        { question: "Walk me through your churn prediction project.", answerGuidance: "Use the STAR structure. Emphasize the 18% targeting improvement and the business decision it enabled, not just the model." },
        { question: "How would you explain a machine learning model to a non-technical manager?", answerGuidance: "Pick a simple analogy. Reference how you presented findings to management during your internship." },
        { question: "What's the difference between supervised and unsupervised learning?", answerGuidance: "Give crisp definitions plus one example each; mention which you used in your projects." },
        { question: "Tell me about a time you worked with messy data.", answerGuidance: "Behavioral — describe a cleaning/wrangling situation from a project, the steps you took, and the outcome." },
      ],
      resourceSuggestions: ["TensorFlow official tutorials", "Kaggle Learn micro-courses", "StatQuest (YouTube) for ML intuition", "Google Data Analytics resources for visualization"],
    });
  }

  throw new Error(`Unknown mock agent: ${agent}`);
}
