/**
 * Fork. The organisation's settings as one account is told them, in the
 * credentials list answer (lib/server/credentials/routes.ts). Every account
 * gets the catalog; only an admin is told which account last changed each
 * part, and whether it was them -- the same rule as a shared key's sharer.
 */

import type { OrgCatalog, OrgDefaultModel, OrgProviderModels } from './store';

interface Stamp {
  updatedAt: number;
  updatedBy?: string;
  updatedByYou?: boolean;
}

export interface OrgCatalogAnswer {
  models: Record<string, OrgProviderModels & Stamp>;
  defaultModel?: OrgDefaultModel & Stamp;
}

/** An owner id as an admin can look it up: the account id, without the channel prefix. */
const accountOf = (ownerId: string) => ownerId.replace(/^user:/u, '');

export function orgForViewer(
  catalog: OrgCatalog,
  role: 'admin' | 'user',
  owner: string,
): OrgCatalogAnswer {
  const stamp = (updatedBy: string, updatedAt: number): Stamp => ({
    updatedAt,
    ...(role === 'admin'
      ? {
          updatedByYou: !!updatedBy && updatedBy === owner,
          ...(updatedBy ? { updatedBy: accountOf(updatedBy) } : {}),
        }
      : {}),
  });
  const answer: OrgCatalogAnswer = { models: {} };
  for (const [providerId, setting] of Object.entries(catalog.models)) {
    answer.models[providerId] = {
      ...setting.value,
      ...stamp(setting.updatedBy, setting.updatedAt),
    };
  }
  if (catalog.defaultModel) {
    const { value, updatedBy, updatedAt } = catalog.defaultModel;
    answer.defaultModel = { ...value, ...stamp(updatedBy, updatedAt) };
  }
  return answer;
}
