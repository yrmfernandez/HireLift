import { extract } from "./agents/extractor.js";
import { write } from "./agents/writer.js";
import { judge } from "./agents/judge.js";

const MAX_ITERATIONS = 3;

/**
 * Runs the full three-agent pipeline:
 *   Extractor -> (Writer -> Judge) loop, bounded by MAX_ITERATIONS.
 *
 * Returns the approved resume, or the best-scoring draft if the judge never
 * approves within the iteration cap. The loop is ALWAYS bounded so it can
 * never run forever.
 *
 * @returns {Promise<{resume: string, approved: boolean, score: number, iterations: number, history: Array}>}
 */
export async function generateResume(jobDescription, userDetails) {
  // Agent 1: extract the valuable info once.
  const extracted = await extract(jobDescription, userDetails);

  let feedback = "";
  let best = { resume: null, score: -1, approved: false };
  const history = [];

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    // Agent 2: write (or rewrite using the judge's feedback).
    const draft = await write(extracted, feedback);

    // Agent 3: judge.
    const verdict = await judge(draft, extracted);
    history.push({ iteration: i, score: verdict.score, approved: verdict.approved });

    // Track the best draft so far, so we never return something worse.
    if (verdict.score > best.score) {
      best = { resume: draft, score: verdict.score, approved: verdict.approved };
    }

    if (verdict.approved) {
      return { resume: draft, approved: true, score: verdict.score, iterations: i, history };
    }

    // Feed specific feedback into the next rewrite.
    feedback = verdict.feedback;
  }

  // Judge never approved within the cap — return the best effort.
  return {
    resume: best.resume,
    approved: false,
    score: best.score,
    iterations: MAX_ITERATIONS,
    history,
  };
}
