/**
 * Lazy-initialized Anthropic client singleton.
 *
 * Shared across eval-opt, briefing, and social tools.
 * Server starts without ANTHROPIC_API_KEY - error only surfaces
 * when a tool that needs the API is actually called.
 */

import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required for briefing/social tools. ' +
        'Set it in your environment or .env file.'
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}
