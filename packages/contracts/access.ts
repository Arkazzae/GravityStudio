export const API_SCOPES = ['models:read', 'jobs:read', 'jobs:write', 'jobs:cancel', 'assets:read', 'assets:write', 'assets:delete', 'text:generate', 'system:read'] as const;
export type ApiScope = typeof API_SCOPES[number];
export const LEGACY_API_SCOPES: readonly ApiScope[] = API_SCOPES.filter(scope => scope !== 'text:generate');
export const DEFAULT_API_SCOPES: readonly ApiScope[] = ['models:read', 'jobs:read', 'jobs:write', 'jobs:cancel', 'assets:read', 'assets:write', 'system:read'];
export interface ApiToken { id: string; name: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; scopes: ApiScope[] }
