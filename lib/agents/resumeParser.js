import { callGroq, parseJsonResponse } from "../groqClient.js";
import { PARSE_RESUME_SYSTEM, buildParseResumeUser } from "../prompts/parseResumePrompt.js";

// gpt-oss-20b: extraction is a structured task the smaller model handles
// well with a strong prompt, and its higher free-tier TPM lets us send the
// whole resume without truncation (120b's 8K TPM was too tight).
const MODEL = "openai/gpt-oss-20b";

// A stricter reminder appended on the fallback attempt. The most common reason
// a resume parse produces invalid JSON is unescaped newlines/quotes inside the
// long experience/projects string values, so we spell out the escaping rules.
const JSON_STRICT_REMINDER = `

CRITICAL JSON RULES (follow exactly):
- Output ONLY the JSON object. No markdown fences, no text before or after.
- Inside string values, escape every newline as \\n and every double quote as \\". Never put a raw line break inside a string.
- Every key and string value must be wrapped in double quotes. No trailing commas.`;

/**
 * Resume parser — turns the raw text of an uploaded resume into structured
 * fields that pre-fill the builder form.
 */
export async function parseResume(resumeText) {
  // First attempt: full prompt.
  try {
    const raw = await callGroq({
      agent: "resumeParser",
      model: MODEL,
      system: PARSE_RESUME_SYSTEM,
      user: buildParseResumeUser(resumeText),
      json: true,
      temperature: 0.1, // near-deterministic: we want faithful extraction
      maxTokens: 2400, // clamped further by callGroq to fit the 8000 TPM budget
    });
    return parseJsonResponse(raw);
  } catch (firstErr) {
    // Fallback: retry once at temperature 0 with an explicit JSON-escaping
    // reminder. This recovers the common case where a bullet-heavy resume made
    // the model emit unescaped newlines/quotes and produce invalid JSON.
    try {
      const raw = await callGroq({
        agent: "resumeParser",
        model: MODEL,
        system: PARSE_RESUME_SYSTEM + JSON_STRICT_REMINDER,
        user: buildParseResumeUser(resumeText),
        json: true,
        temperature: 0,
        maxTokens: 2400,
      });
      return parseJsonResponse(raw);
    } catch {
      // Both attempts failed — surface the original error so the route can map
      // it to a helpful user message.
      throw firstErr;
    }
  }
}
