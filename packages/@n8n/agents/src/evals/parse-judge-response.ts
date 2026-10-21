import { extractJsonCandidate } from '@n8n/ai-utilities/llm-output';

import type { EvalScore } from '../types';

/** Reads a boolean verdict, or the string `"true"` / `"false"` in any case. */
function readPass(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value;
	if (typeof value !== 'string') return undefined;
	const lower = value.toLowerCase();
	if (lower === 'true' || lower === 'false') return lower === 'true';
	return undefined;
}

/**
 * Parse an LLM judge response into an EvalScore (pass/fail).
 * Handles JSON wrapped in markdown fences, plain JSON, or raw text.
 *
 * A response without a readable verdict fails closed and is marked
 * `inconclusive`, so callers can tell "the judge said fail" from "the judge
 * gave no verdict". Keywords in free text are not a verdict: "does not pass"
 * contains "pass".
 */
export function parseJudgeResponse(text: string): EvalScore {
	const stripped = extractJsonCandidate(text);

	let parsed: { pass?: unknown; score?: unknown; reasoning?: string } | undefined;
	try {
		const value: unknown = JSON.parse(stripped);
		if (typeof value === 'object' && value !== null) parsed = value;
	} catch {
		parsed = undefined;
	}

	if (parsed) {
		const reasoning = parsed.reasoning ?? stripped;
		const pass = readPass(parsed.pass);
		if (pass !== undefined) return { pass, reasoning };
		// Legacy format: { score: 0.8 }. Used only when there is no valid pass value.
		if (typeof parsed.score === 'number') return { pass: parsed.score >= 0.7, reasoning };
		return { pass: false, reasoning, inconclusive: true };
	}

	// Malformed JSON can still carry an explicit verdict, e.g. a truncated reply.
	const lowerText = stripped.toLowerCase();
	if (lowerText.includes('"pass": true') || lowerText.includes('"pass":true')) {
		return { pass: true, reasoning: stripped };
	}
	if (lowerText.includes('"pass": false') || lowerText.includes('"pass":false')) {
		return { pass: false, reasoning: stripped };
	}
	return { pass: false, reasoning: stripped, inconclusive: true };
}
