export type { TextSettings, TextProviderId, TextModel, PromptRefinementResult as RefinementResult } from '../../../../packages/contracts/text';

export const textProviderName = (provider: 'gemini' | 'openai-compatible') => provider === 'gemini' ? 'Gemini' : 'OpenAI-compatible';
