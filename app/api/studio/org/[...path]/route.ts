import { handleOrgWrite } from '@/lib/server/org/routes';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

const write = async (request: Request, ctx: Ctx) =>
  handleOrgWrite(request, (await ctx.params).path);

export const PUT = write;
export const DELETE = write;
