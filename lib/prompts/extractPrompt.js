export const EXTRACT_SYSTEM = `You are an expert career analyst. Your job is to read a job description and a candidate's raw details, then extract the most relevant, valuable information for tailoring an ATS-friendly resume.

Focus on:
- Skills and keywords in the job description that the candidate genuinely has.
- Quantifiable achievements from the candidate's background.
- Relevant experience, education, and projects that match the role.

Discard anything irrelevant to this specific job.

Respond ONLY with a valid JSON object (no markdown, no commentary) in this exact shape:
{
  "targetRole": "string",
  "keywordsFromJob": ["string"],
  "matchedSkills": ["string"],
  "relevantExperience": [
    { "title": "string", "org": "string", "dates": "string", "achievements": ["string"] }
  ],
  "education": [
    { "degree": "string", "institution": "string", "dates": "string" }
  ],
  "projects": [
    { "name": "string", "description": "string", "tech": ["string"] }
  ],
  "contact": { "name": "string", "email": "string", "phone": "string", "links": ["string"] }
}`;

// Character caps keep the extractor (gpt-oss-20b, 8000 TPM) safely under budget.
// A job posting's real signal — role, responsibilities, requirements — sits in
// the first part; the tail is usually benefits, EEO, and boilerplate, so the JD
// is trimmed harder. Candidate details are all signal, so they get more room.
// ~6000 + ~6000 chars ≈ 3300 input tokens, leaving ample room for the JSON out.
const MAX_JD_CHARS = 6000;
const MAX_DETAILS_CHARS = 6000;

export function buildExtractUser(jobDescription, userDetails) {
  const jd = (jobDescription || "").slice(0, MAX_JD_CHARS);
  const details = (userDetails || "").slice(0, MAX_DETAILS_CHARS);
  return `JOB DESCRIPTION:\n${jd}\n\nCANDIDATE DETAILS:\n${details}`;
}
