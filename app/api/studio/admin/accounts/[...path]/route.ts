import { handleAccounts } from '@/lib/server/accounts/routes';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

const handle = async (request: Request, ctx: Ctx) =>
  handleAccounts(request, (await ctx.params).path);

export const GET = handle;
export const DELETE = handle;
