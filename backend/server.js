import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { generateResume } from "./pipeline.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Main endpoint: run the three-agent pipeline.
app.post("/api/generate", async (req, res) => {
  const { jobDescription, userDetails } = req.body || {};

  if (!jobDescription || !userDetails) {
    return res
      .status(400)
      .json({ error: "Both 'jobDescription' and 'userDetails' are required." });
  }

  try {
    const result = await generateResume(jobDescription, userDetails);
    res.json(result);
  } catch (err) {
    console.error("[/api/generate] pipeline error:", err);
    res.status(500).json({ error: "Resume generation failed.", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AI Resume Builder backend running on http://localhost:${PORT}`);
});
