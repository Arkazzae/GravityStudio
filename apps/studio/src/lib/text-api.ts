export type { TextSettings, TextProviderId, TextModel, LocalTextStatus, PromptRefinementResult as RefinementResult } from '../../../../packages/contracts/text';

export const textProviderName = (provider: 'gemini' | 'openai-compatible' | 'local') => provider === 'local' ? 'Local Studio' : provider === 'gemini' ? 'Gemini' : 'OpenAI-compatible';
