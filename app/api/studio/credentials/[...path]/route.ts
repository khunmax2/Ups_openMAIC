import { handleWrite } from '@/lib/server/credentials/routes';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

const write = async (request: Request, ctx: Ctx) => handleWrite(request, (await ctx.params).path);

export const PUT = write;
export const DELETE = write;
