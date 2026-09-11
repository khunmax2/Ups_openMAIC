import { handleList } from '@/lib/server/credentials/routes';

export const runtime = 'nodejs';

export const GET = (request: Request) => handleList(request);
