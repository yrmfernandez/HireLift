import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  console.warn(
    "[groqClient] Warning: GROQ_API_KEY is not set. Copy .env.example to .env and add your key."
  );
}

// Groq is OpenAI-SDK compatible — we just point the base URL at Groq.
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Call a Groq chat model.
 * @param {Object} opts
 * @param {string} opts.model      - Groq model ID
 * @param {string} opts.system     - system prompt
 * @param {string} opts.user       - user message
 * @param {boolean} [opts.json]    - request JSON output
 * @param {number} [opts.temperature]
 * @returns {Promise<string>} the model's text response
 */
export async function callGroq({ model, system, user, json = false, temperature = 0.7 }) {
  const response = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(json ? { response_format: { type: "json_object" } } : {}),
  });

  return response.choices[0].message.content;
}

/** Safely parse a JSON string returned by a model. Throws a clear error on failure. */
export function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse model JSON response. Raw output:\n${text}\n\nError: ${err.message}`
    );
  }
}
