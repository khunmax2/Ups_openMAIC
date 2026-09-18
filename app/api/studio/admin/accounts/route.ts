import { handleAccounts } from '@/lib/server/accounts/routes';

export const runtime = 'nodejs';

export const GET = (request: Request) => handleAccounts(request, []);
